import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { buildSearchQuery } from "../utils/search";

export const getSongs = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id;
    const userIdStr = userId.toString();
    const { page = 1, limit = 50, search, sortBy, channelUsername } = req.query;
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
      const songs = result.data ?? [];
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

    const [result] = await db
      .collection("songs")
      .aggregate([
        { $match: query },
        { $addFields: { _sortDate: "$messageDate" } },
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
                  _sortDate: "$receivedAt",
                },
              },
            ],
          },
        },
        { $sort: { _sortDate: -1 } },
        {
          $facet: {
            meta: [{ $count: "total" }],
            data: [{ $skip: skip }, { $limit: limitNum }],
          },
        },
      ])
      .toArray();

    const total = result.meta[0]?.total ?? 0;
    const songs = result.data ?? [];
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

    res.json({ success: true, data: song });
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

    const ordered = ids.map((id) => songMap.get(id)).filter(Boolean);

    res.json({ success: true, data: ordered });
  } catch (error) {
    next(error);
  }
};
