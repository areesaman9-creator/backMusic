import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { buildSearchQuery } from "../utils/search";
import {
  signThumbnailUrl,
  verifyThumbnailToken,
} from "../utils/thumbnailToken";
import telegramService from "../services/telegram";

// ── Cursor helpers ────────────

interface MergeCursor {
  s: string | null;
  sId: string | null;
  b: string | null;
  bId: string | null;
}

function encodeCursor(c: MergeCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64");
}

function decodeCursor(raw: string): MergeCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      s: parsed.s ?? null,
      sId: parsed.sId ?? null,
      b: parsed.b ?? null,
      bId: parsed.bId ?? null,
    };
  } catch {
    return null;
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
    } = req.query;
    const db = mongoose.connection.db;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(200, parseInt(limit as string));
    const skip = (pageNum - 1) * limitNum;

    const query: Record<string, any> = {};

    if (channelUsername) {
      const hasChannel = await db.collection("user_channels").findOne({
        userId: userIdStr,
        channelUsername: channelUsername,
      });
      if (!hasChannel) {
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
        .find({ userId: userIdStr, isDefault: { $ne: true } })
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
      const { clauses } = buildSearchQuery(rawSearch);
      if (clauses.length > 0) {
        query.$and = clauses;
      }
    }

    const includeBotSongs = !channelUsername && !hasSearch && !sortBy;

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
        thumbnail: signThumbnailUrl(s._id.toString()),
      }));
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

    const rawCursor =
      typeof cursor === "string" && cursor.trim() ? decodeCursor(cursor) : null;

    if (!rawCursor && pageNum > 1) {

      return res.status(400).json({
        success: false,
        message:
          "Pagination beyond page 1 for this listing requires the 'cursor' from the previous response.",
      });
    }

    const songFilter: Record<string, any> = { ...query };
    if (rawCursor?.s) {
      songFilter.$or = [
        { messageDate: { $lt: new Date(rawCursor.s) } },
        {
          messageDate: new Date(rawCursor.s),
          _id: { $lt: new mongoose.Types.ObjectId(rawCursor.sId!) },
        },
      ];
    }

    const botFilter: Record<string, any> = { userId: userIdStr };
    if (rawCursor?.b) {
      botFilter.$or = [
        { receivedAt: { $lt: new Date(rawCursor.b) } },
        {
          receivedAt: new Date(rawCursor.b),
          _id: { $lt: new mongoose.Types.ObjectId(rawCursor.bId!) },
        },
      ];
    }

    const windowSize = limitNum + 1;

    const [songWindow, botWindow, songsTotal, botTotal] = await Promise.all([
      db
        .collection("songs")
        .find(songFilter)
        .sort({ messageDate: -1, _id: -1 })
        .limit(windowSize)
        .toArray(),
      db
        .collection("bot_songs")
        .find(botFilter)
        .sort({ receivedAt: -1, _id: -1 })
        .limit(windowSize)
        .toArray(),
      db.collection("songs").countDocuments(query),
      db.collection("bot_songs").countDocuments({ userId: userIdStr }),
    ]);

    const normalizedSongs = songWindow.map((s) => ({
      ...s,
      _sortDate: s.messageDate,
    }));
    const normalizedBot = botWindow.map((s) => ({
      _id: s._id,
      channelDbId: s._id.toString(),
      channelUsername: s.channelUsername,
      channelName: "Bot Inbox",
      title: s.title,
      artist: s.artist,
      duration: s.duration,
      fileId: s.fileId,
      fileSize: s.fileSize,
      mimeType: s.mimeType,
      thumbnail: s.thumbnail,
      messageId: s.messageId,
      _sortDate: s.receivedAt,
    }));

    let i = 0;
    let j = 0;
    const pageItems: any[] = [];
    while (
      pageItems.length < limitNum &&
      (i < normalizedSongs.length || j < normalizedBot.length)
    ) {
      const a = normalizedSongs[i];
      const b = normalizedBot[j];
      let takeFromSongs: boolean;
      if (a === undefined) takeFromSongs = false;
      else if (b === undefined) takeFromSongs = true;
      else
        takeFromSongs =
          new Date(a._sortDate).getTime() >= new Date(b._sortDate).getTime();

      if (takeFromSongs) {
        pageItems.push(a);
        i++;
      } else {
        pageItems.push(b);
        j++;
      }
    }

    const hasMore = i < normalizedSongs.length || j < normalizedBot.length;
    const lastSong = i > 0 ? normalizedSongs[i - 1] : null;
    const lastBot = j > 0 ? normalizedBot[j - 1] : null;

    const nextCursor = hasMore
      ? encodeCursor({
          s: lastSong
            ? new Date(lastSong._sortDate).toISOString()
            : (rawCursor?.s ?? null),
          sId: lastSong ? lastSong._id.toString() : (rawCursor?.sId ?? null),
          b: lastBot
            ? new Date(lastBot._sortDate).toISOString()
            : (rawCursor?.b ?? null),
          bId: lastBot ? lastBot._id.toString() : (rawCursor?.bId ?? null),
        })
      : null;

    const songs = pageItems.map(({ _sortDate, ...rest }: any) => ({
      ...rest,
      thumbnail: signThumbnailUrl(rest._id.toString()),
    }));

    const total = songsTotal + botTotal;
    const totalPages = Math.ceil(total / limitNum);

    res.json({
      success: true,
      data: songs,
      total,
      page: pageNum,
      totalPages,
      hasMore,
      nextCursor,
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
      data: { ...song, thumbnail: signThumbnailUrl(song._id.toString()) },
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
        thumbnail: signThumbnailUrl(s._id.toString()),
      }));
    res.json({ success: true, data: ordered });
  } catch (error) {
    next(error);
  }
};

// ── In-memory cache تامبنیل — تا هر request مجبور نشه از تلگرام دانلود کنه ──
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

// ── NEW: لاگ ساخت‌یافته برای تشخیص مشکل شبکه/اپراتور ──
function logThumbAccess(req: Request, extra: Record<string, any>) {
  try {
    console.log(
      JSON.stringify({
        tag: "thumb_access",
        ts: new Date().toISOString(),
        cfRay: req.headers["cf-ray"] || null,
        cfCountry: req.headers["cf-ipcountry"] || null,
        cfConnectingIp: req.headers["cf-connecting-ip"] || req.ip,
        ua: req.headers["user-agent"] || null,
        encoding: req.query.encoding || "binary",
        ...extra,
      }),
    );
  } catch {}
}

// ── GET /api/songs/:id/thumbnail?exp=...&sig=...[&encoding=base64] ─────────
// عمداً authenticate نداره — امضای HMAC خودش auth رو تأمین می‌کنه
export const getSongThumbnail = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const startedAt = Date.now();
  const { id } = req.params;
  const wantsBase64 = req.query.encoding === "base64";

  try {
    const exp = parseInt((req.query.exp as string) || "0", 10);
    const sig = (req.query.sig as string) || "";

    if (!verifyThumbnailToken(id, exp, sig)) {
      logThumbAccess(req, { id, result: "invalid_signature", ms: Date.now() - startedAt });
      return res
        .status(403)
        .json({ success: false, message: "Invalid or expired link" });
    }

    const respond = (buffer: Buffer, source: string) => {
      logThumbAccess(req, {
        id,
        result: "ok",
        source,
        bytes: buffer.length,
        ms: Date.now() - startedAt,
      });

      // مسیر fallback: بجای باینری image/jpeg، JSON برمی‌گردونیم.
      // پراکسی‌های فشرده‌سازی عکس اپراتور و Cloudflare Polish روی
      // application/json دست نمی‌زنن، فقط روی image/* فعال می‌شن.
      if (wantsBase64) {
        return res.json({
          success: true,
          dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
        });
      }

      res.set({
        "Content-Type": "image/jpeg",
        "Content-Length": buffer.length.toString(),
        // no-transform: به CDN/پراکسی‌های میانی می‌گه بایت‌ها رو دست نزنن
        "Cache-Control": "public, max-age=86400, immutable, no-transform",
        "X-Thumb-Source": source,
      });
      return res.send(buffer);
    };

    const cached = getCachedThumb(id);
    if (cached) return respond(cached, "server-cache");

    let objId: mongoose.Types.ObjectId;
    try {
      objId = new mongoose.Types.ObjectId(id);
    } catch {
      logThumbAccess(req, { id, result: "invalid_id", ms: Date.now() - startedAt });
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
        logThumbAccess(req, { id, result: "song_not_found", ms: Date.now() - startedAt });
        return res
          .status(404)
          .json({ success: false, message: "Song not found" });
      }
      botUserId = (doc as any).userId;
    }

    const dataUrl = await telegramService.downloadSongThumbnail(
      doc.channelUsername,
      doc.messageId,
      botUserId,
    );
    if (!dataUrl) {
      logThumbAccess(req, { id, result: "telegram_no_thumb", ms: Date.now() - startedAt });
      return res
        .status(404)
        .json({ success: false, message: "No thumbnail available" });
    }

    const buffer = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
    if (buffer.length === 0) {
      logThumbAccess(req, { id, result: "empty_buffer", ms: Date.now() - startedAt });
      return res
        .status(404)
        .json({ success: false, message: "No thumbnail available" });
    }

    setCachedThumb(id, buffer);
    return respond(buffer, "telegram-fresh");
  } catch (error: any) {
    logThumbAccess(req, {
      id,
      result: "exception",
      error: error?.message,
      ms: Date.now() - startedAt,
    });
    next(error);
  }
};