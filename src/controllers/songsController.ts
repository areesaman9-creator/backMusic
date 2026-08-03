import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import {
  buildArtistSearchQuery,
  buildSearchQuery,
  buildTitleSearchQuery,
} from "../utils/search";
import {
  signThumbnailUrl,
  verifyThumbnailToken,
} from "../utils/thumbnailToken";
import telegramService from "../services/telegram";

async function _describeThumbnailRequester(
  uid: string,
  db: any,
): Promise<string> {
  if (!uid) return "unknown (no uid)";
  try {
    const user = await db
      .collection("users")
      .findOne(
        { _id: new mongoose.Types.ObjectId(uid) },
        { projection: { telegramUsername: 1, telegramId: 1 } },
      );
    if (!user) return `uid=${uid} (user not found)`;
    return `@${user.telegramUsername || "—"} (tgId:${user.telegramId || "—"}, uid:${uid})`;
  } catch {
    return `uid=${uid} (invalid)`;
  }
}

export const getSongs = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id;
    const userIdStr = userId.toString();
    const {
      page = 1,
      limit = 50,
      search,
      sortBy,
      channelUsername,
      cursor,
      searchField,
    } = req.query;
    const db = mongoose.connection.db;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(200, parseInt(limit as string));
    const skip = (pageNum - 1) * limitNum;

    const query: Record<string, any> = {};

    if (channelUsername) {
      const channelExists = await db.collection("channels").findOne({
        channelUsername: channelUsername,
      });
      if (!channelExists) {
        return res.json({
          success: true,
          data: [],
          total: 0,
          page: pageNum,
          totalPages: 0,
          hasMore: false,
        });
      }
      query.channelUsername = channelUsername;
    } else {
      const userChannels = await db
        .collection("user_channels")
        .find({ userId: userIdStr })
        .project({ channelUsername: 1 })
        .toArray();

      query.channelUsername = {
        $in: userChannels.map((ch) => ch.channelUsername),
      };
    }

    let sort: Record<string, any> = { messageDate: -1 };
    if (sortBy === "title") sort = { title: 1 };
    else if (sortBy === "artist") sort = { artist: 1 };

    const rawSearch = search;
    let hasSearch = false;
    if (typeof rawSearch === "string" && rawSearch.trim()) {
      hasSearch = true;
      const { clauses } =
        searchField === "artist"
          ? buildArtistSearchQuery(rawSearch)
          : searchField === "title"
            ? buildTitleSearchQuery(rawSearch)
            : buildSearchQuery(rawSearch);
      if (clauses.length > 0) {
        query.$and = clauses;
      }
    }

    // در حالت هوم‌اسکرین (بدون channelUsername و بدون سرچ) آهنگ‌های
    // Bot Inbox هم با اتحادِ کالکشن bot_songs داخل نتیجه ادغام می‌شن.
    const includeBotSongs = !channelUsername && !hasSearch;

    if (!includeBotSongs) {
      const [result] = await db
        .collection("songs")
        .aggregate([
          { $match: query },
          {
            $facet: {
              meta: [{ $count: "total" }],
              data: [{ $sort: sort }, { $skip: skip }, { $limit: limitNum }],
            },
          },
        ])
        .toArray();

      const total = result.meta[0]?.total ?? 0;
      const songs = (result.data ?? []).map((s: any) => ({
        ...s,
        thumbnail: s.thumbnail || signThumbnailUrl(s._id.toString(), userIdStr),      }));
      const totalPages = Math.ceil(total / limitNum);

      return res.json({
        success: true,
        data: songs,
        total,
        page: pageNum,
        totalPages,
        hasMore: pageNum < totalPages,
      });
    }

    const [mergedResult] = await db
      .collection("songs")
      .aggregate([
        { $match: query },
        {
          $unionWith: {
            coll: "bot_songs",
            pipeline: [
              { $match: { userId: userIdStr } },
              {
                $project: {
                  _id: 1,
                  channelDbId: { $toString: "$_id" },
                  channelUsername: 1,
                  channelName: { $literal: "Bot Inbox" },
                  title: 1,
                  artist: 1,
                  duration: 1,
                  fileId: 1,
                  fileSize: 1,
                  mimeType: 1,
                  thumbnail: 1,
                  messageId: 1,
                  messageDate: "$receivedAt",
                },
              },
            ],
          },
        },
        {
          $facet: {
            meta: [{ $count: "total" }],
            data: [{ $sort: sort }, { $skip: skip }, { $limit: limitNum }],
          },
        },
      ])
      .toArray();

    const total = mergedResult.meta[0]?.total ?? 0;
    const songs = (mergedResult.data ?? []).map((s: any) => ({
      ...s,
      thumbnail: signThumbnailUrl(s._id.toString(), userIdStr),
    }));
    const totalPages = Math.ceil(total / limitNum);

    res.json({
      success: true,
      data: songs,
      total,
      page: pageNum,
      totalPages,
      hasMore: pageNum < totalPages,
    });
  } catch (error) {
    next(error);
  }
};
// ── GET /api/songs/:id ─────────────────────────────────────────
export const getSongById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id } = req.params;
    const db = mongoose.connection.db;

    let objId: mongoose.Types.ObjectId;
    try {
      objId = new mongoose.Types.ObjectId(id);
    } catch {
      return res
        .status(400)
        .json({ success: false, message: "Invalid song id" });
    }

    const song = await db.collection("songs").findOne({ _id: objId });
    if (!song)
      return res
        .status(404)
        .json({ success: false, message: "Song not found" });

    const owns = await db
      .collection("user_channels")
      .findOne(
        { userId, channelUsername: song.channelUsername },
        { projection: { _id: 1 } },
      );
    if (!owns)
      return res
        .status(404)
        .json({ success: false, message: "Song not found" });

    res.json({
      success: true,
      data: {
        ...song,
        thumbnail: song.thumbnail || signThumbnailUrl(song._id.toString(), userId),      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/songs/by-ids?ids=id1,id2,id3 ──────────────────────
export const getSongsByIds = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const idsParam = (req.query.ids as string) || "";
    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const objIds = ids
      .map((id) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as mongoose.Types.ObjectId[];

    const db = mongoose.connection.db;

    const [songs, botSongs] = await Promise.all([
      db
        .collection("songs")
        .find({ _id: { $in: objIds } })
        .toArray(),
      db
        .collection("bot_songs")
        .find({ _id: { $in: objIds }, userId })
        .toArray(),
    ]);

    const songMap = new Map(songs.map((s: any) => [s._id.toString(), s]));
    for (const bs of botSongs) {
      songMap.set(bs._id.toString(), {
        _id: bs._id,
        channelDbId: bs._id.toString(),
        channelUsername: bs.channelUsername,
        channelName: "Bot Inbox",
        title: bs.title,
        artist: bs.artist,
        duration: bs.duration,
        fileId: bs.fileId,
        fileSize: bs.fileSize,
        thumbnail: bs.thumbnail,
        messageId: bs.messageId,
      });
    }

    const ordered = ids
      .map((id) => songMap.get(id))
      .filter(Boolean)
      .map((s: any) => ({
        ...s,
        thumbnail: s.thumbnail || signThumbnailUrl(s._id.toString(), userId),}));
    res.json({ success: true, data: ordered });
  } catch (error) {
    next(error);
  }
};

// ── In-memory cache ──
const THUMB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const THUMB_CACHE_MAX = 2000;
const thumbCache = new Map<string, { buffer: Buffer; expiresAt: number }>();

function getCachedThumb(id: string): Buffer | null {
  const entry = thumbCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    thumbCache.delete(id);
    return null;
  }
  return entry.buffer;
}

function setCachedThumb(id: string, buffer: Buffer) {
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    thumbCache.delete(thumbCache.keys().next().value);
  }
  thumbCache.set(id, { buffer, expiresAt: Date.now() + THUMB_CACHE_TTL_MS });
}

// ── GET /api/songs/:id/thumbnail?exp=...&sig=... ─────────────────
export const getSongThumbnail = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const exp = parseInt((req.query.exp as string) || "0", 10);
    const sig = (req.query.sig as string) || "";
    const uid = (req.query.uid as string) || "";

    if (!verifyThumbnailToken(id, exp, sig, uid)) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid or expired link" });
    }

    if (uid) {
      (req as any).user = { _id: uid };
      try {
        const uidUser = await mongoose.connection.db
          .collection("users")
          .findOne(
            { _id: new mongoose.Types.ObjectId(uid) },
            { projection: { telegramId: 1, telegramUsername: 1 } },
          );
        if (uidUser) {
          (req as any).user.telegramId = uidUser.telegramId ?? null;
          (req as any).user.telegramUsername = uidUser.telegramUsername ?? null;
        }
      } catch {}
    }

    const cached = getCachedThumb(id);
    if (cached) {
      res.set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400, immutable",
      });
      return res.send(cached);
    }

    let objId: mongoose.Types.ObjectId;
    try {
      objId = new mongoose.Types.ObjectId(id);
    } catch {
      return res
        .status(400)
        .json({ success: false, message: "Invalid song id" });
    }

    const db = mongoose.connection.db;
    let doc = await db
      .collection("songs")
      .findOne(objId ? { _id: objId } : {}, {
        projection: { channelUsername: 1, messageId: 1 },
      });

    let botUserId: string | undefined;
    if (!doc) {
      doc = await db
        .collection("bot_songs")
        .findOne(
          { _id: objId },
          { projection: { channelUsername: 1, messageId: 1, userId: 1 } },
        );
      if (!doc) {
        console.warn(
          `⚠️ [thumbnail 404] songId=${id} requestedBy=${await _describeThumbnailRequester(uid, db)}`,
        );
        return res
          .status(404)
          .json({ success: false, message: "Song not found" });
      }
      botUserId = (doc as any).userId;
    }

    const requesterUser = (req as any).user;
    const dataUrl = await telegramService.downloadSongThumbnail(
      doc.channelUsername,
      doc.messageId,
      botUserId,
      {
        telegramId: requesterUser?.telegramId ?? null,
        telegramUsername: requesterUser?.telegramUsername ?? null,
        userId: uid || botUserId || null,
      },
    );
    if (!dataUrl) {
      return res
        .status(404)
        .json({ success: false, message: "No thumbnail available" });
    }

    const buffer = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
    if (buffer.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "No thumbnail available" });
    }

    setCachedThumb(id, buffer);
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400, immutable",
    });
    res.send(buffer);
  } catch (error) {
    next(error);
  }
};
