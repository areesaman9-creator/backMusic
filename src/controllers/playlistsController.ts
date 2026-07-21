import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { signThumbnailUrl } from "../utils/thumbnailToken";

// ── GET /api/playlists ─────────────────────────────────────────
export const getPlaylists = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    const playlists = await db
      .collection("user_playlists")
      .aggregate([
        { $match: { userIds: userId } },
        { $sort: { updatedAt: -1 } },
        {
          $addFields: {
            songsCount: { $size: { $ifNull: ["$songIds", []] } },
            isOwner: { $eq: ["$ownerId", userId] },
          },
        },
      ])
      .toArray();

    res.json({ success: true, data: playlists });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/playlists ────────────────────────────────────────
export const createPlaylist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { name } = req.body;
    if (!name)
      return res.status(400).json({ success: false, msg: "name required" });

    const db = mongoose.connection.db;

    const existing = await db
      .collection("user_playlists")
      .findOne({ userIds: userId, name });
    if (existing)
      return res
        .status(400)
        .json({ success: false, msg: "Playlist name already exists" });

    const newPlaylist = {
      ownerId: userId,
      userIds: [userId],
      name,
      coverImage: null,
      songIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("user_playlists").insertOne(newPlaylist);
    res.status(201).json({
      success: true,
      msg: "Playlist created",
      data: {
        _id: result.insertedId,
        ...newPlaylist,
        songsCount: 0,
        isOwner: true,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/playlists/:id ─────────────────────────────────────
export const updatePlaylist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const { name } = req.body;

    if (!name || !name.toString().trim())
      return res.status(400).json({ success: false, msg: "name required" });

    const db = mongoose.connection.db;
    const trimmedName = name.toString().trim();
    const objId = new mongoose.Types.ObjectId(playlistId);

    const playlist = await db
      .collection("user_playlists")
      .findOne({ _id: objId });
    if (!playlist)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });
    if (playlist.ownerId !== userId)
      return res
        .status(403)
        .json({ success: false, msg: "Only the playlist owner can rename it" });

    const existing = await db.collection("user_playlists").findOne({
      userIds: userId,
      name: trimmedName,
      _id: { $ne: objId },
    });
    if (existing)
      return res
        .status(400)
        .json({ success: false, msg: "Playlist name already exists" });

    await db
      .collection("user_playlists")
      .updateOne(
        { _id: objId },
        { $set: { name: trimmedName, updatedAt: new Date() } },
      );

    res.json({ success: true, msg: "Playlist updated" });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/playlists/:id ──────────────────────────────────
export const deletePlaylist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const db = mongoose.connection.db;

    let objId: mongoose.Types.ObjectId;
    try {
      objId = new mongoose.Types.ObjectId(playlistId);
    } catch {
      return res
        .status(400)
        .json({ success: false, msg: "Invalid playlist id" });
    }

    const playlist = await db
      .collection("user_playlists")
      .findOne({ _id: objId });
    if (!playlist)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });

    if (playlist.ownerId === userId) {
      await db.collection("user_playlists").deleteOne({ _id: objId });
      return res.json({ success: true, msg: "Playlist deleted" });
    }

    if (!(playlist.userIds as string[]).includes(userId)) {
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });
    }

    await db.collection("user_playlists").updateOne(
      { _id: objId },
      {
        $pull: { userIds: userId } as any,
        $set: { updatedAt: new Date() },
      },
    );

    res.json({ success: true, msg: "Left playlist" });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/playlists/:id/songs ───────────────────────────────
export const getPlaylistSongs = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(200, parseInt(limit as string));
    const db = mongoose.connection.db;

    const playlist = await db.collection("user_playlists").findOne({
      _id: new mongoose.Types.ObjectId(playlistId),
      userIds: userId,
    });
    if (!playlist)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });

    const songIds = playlist.songIds ?? [];
    const realCount = songIds.length;
    const skip = (pageNum - 1) * limitNum;
    const pageIds = songIds.slice(skip, skip + limitNum);

    const objIds = pageIds
      .map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const [songs, botSongs] = await Promise.all([
      db
        .collection("songs")
        .aggregate([
          { $match: { _id: { $in: objIds } } },
          {
            $addFields: {
              thumbnail: {
                $cond: [
                  {
                    $gt: [
                      { $strLenBytes: { $ifNull: ["$thumbnail", ""] } },
                      300000,
                    ],
                  },
                  null,
                  "$thumbnail",
                ],
              },
            },
          },
          { $project: { searchWords: 0, searchPrefixes: 0 } },
        ])
        .toArray(),
      db
        .collection("bot_songs")
        .find(
          { _id: { $in: objIds }, userId: playlist.ownerId },
          { projection: { searchWords: 0, searchPrefixes: 0 } },
        )
        .toArray(),
    ]);

    const songMap = new Map(songs.map((s) => [s._id.toString(), s]));

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

    const ordered = pageIds
      .map((id: string) => songMap.get(id))
      .filter(Boolean)
      .map((s: any) => ({
        ...s,
        thumbnail: signThumbnailUrl(s._id.toString()),
      }));

    res.json({
      success: true,
      data: ordered,
      playlist: {
        _id: playlist._id,
        name: playlist.name,
        songsCount: realCount,
        isOwner: playlist.ownerId === userId,
      },
      total: realCount,
      page: pageNum,
      totalPages: Math.ceil(realCount / limitNum),
      hasMore: pageNum < Math.ceil(realCount / limitNum),
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/playlists/:id/songs ──────────────────────────────
export const addSongToPlaylist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const { songId } = req.body;
    if (!songId)
      return res.status(400).json({ success: false, msg: "songId required" });

    const db = mongoose.connection.db;

    const result = await db.collection("user_playlists").updateOne(
      {
        _id: new mongoose.Types.ObjectId(playlistId),
        userIds: userId,
        songIds: { $ne: songId },
      },
      {
        $push: { songIds: songId } as any,
        $set: { updatedAt: new Date() },
      },
    );

    if (result.matchedCount === 0) {
      const exists = await db.collection("user_playlists").findOne({
        _id: new mongoose.Types.ObjectId(playlistId),
        userIds: userId,
      });
      if (!exists)
        return res
          .status(404)
          .json({ success: false, msg: "Playlist not found" });
      return res
        .status(400)
        .json({ success: false, msg: "Song already in playlist" });
    }

    res.json({ success: true, msg: "Song added to playlist" });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/playlists/:id/songs/:songId ────────────────────
export const removeSongFromPlaylist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id: playlistId, songId } = req.params;
    const db = mongoose.connection.db;

    const result = await db.collection("user_playlists").updateOne(
      { _id: new mongoose.Types.ObjectId(playlistId), userIds: userId },
      {
        $pull: { songIds: songId } as any,
        $set: { updatedAt: new Date() },
      },
    );

    if (result.matchedCount === 0)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });

    res.json({ success: true, msg: "Song removed from playlist" });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/playlists/:id/reorder ───────────────────────────
export const reorderPlaylist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id: playlistId } = req.params;
    const { songIds } = req.body;

    if (!Array.isArray(songIds)) {
      return res
        .status(400)
        .json({ success: false, msg: "songIds array required" });
    }

    const db = mongoose.connection.db;
    const result = await db
      .collection("user_playlists")
      .updateOne(
        { _id: new mongoose.Types.ObjectId(playlistId), userIds: userId },
        { $set: { songIds, updatedAt: new Date() } },
      );

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });
    }

    res.json({ success: true, msg: "Playlist reordered" });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/playlists/:id/users ────────────────────────────────
export const getPlaylistUsers = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const db = mongoose.connection.db;

    const playlist = await db.collection("user_playlists").findOne({
      _id: new mongoose.Types.ObjectId(playlistId),
      userIds: userId,
    });
    if (!playlist)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });

    const objIds = (playlist.userIds as string[])
      .map((id) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as mongoose.Types.ObjectId[];

    const users = await db
      .collection("users")
      .find({ _id: { $in: objIds } })
      .project({ name: 1, telegramUsername: 1, telegramId: 1 })
      .toArray();

    const data = users.map((u: any) => ({
      _id: u._id.toString(),
      name: u.name,
      telegramUsername: u.telegramUsername,
      telegramId: u.telegramId,
      isOwner: u._id.toString() === playlist.ownerId,
    }));

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/playlists/:id/users ───────────────────────────────
export const addUserToPlaylist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const playlistId = req.params.id;
    const { telegramId } = req.body;

    if (!telegramId) {
      return res.status(400).json({
        success: false,
        msg: "telegramId required",
      });
    }

    const db = mongoose.connection.db;
    const objId = new mongoose.Types.ObjectId(playlistId);

    const playlist = await db
      .collection("user_playlists")
      .findOne({ _id: objId });
    if (!playlist)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });
    if (playlist.ownerId !== userId)
      return res
        .status(403)
        .json({ success: false, msg: "Only the playlist owner can add users" });

    const query: any = { telegramId: telegramId.toString() };

    const targetUser = await db.collection("users").findOne(query);
    if (!targetUser)
      return res.status(404).json({ success: false, msg: "User not found" });

    const targetId = targetUser._id.toString();
    if ((playlist.userIds as string[]).includes(targetId)) {
      return res
        .status(400)
        .json({ success: false, msg: "User already has access" });
    }

    await db
      .collection("user_playlists")
      .updateOne(
        { _id: objId },
        { $addToSet: { userIds: targetId }, $set: { updatedAt: new Date() } },
      );

    res.json({
      success: true,
      msg: "User added",
      data: {
        _id: targetId,
        name: targetUser.name,
        telegramUsername: targetUser.telegramUsername,
        telegramId: targetUser.telegramId,
        isOwner: false,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/playlists/:id/users/:targetUserId ───────────────
export const removeUserFromPlaylist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id: playlistId, targetUserId } = req.params;
    const db = mongoose.connection.db;
    const objId = new mongoose.Types.ObjectId(playlistId);

    const playlist = await db
      .collection("user_playlists")
      .findOne({ _id: objId });
    if (!playlist)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });
    if (playlist.ownerId !== userId)
      return res.status(403).json({
        success: false,
        msg: "Only the playlist owner can remove users",
      });
    if (targetUserId === playlist.ownerId)
      return res
        .status(400)
        .json({ success: false, msg: "Cannot remove the owner" });

    await db.collection("user_playlists").updateOne(
      { _id: objId },
      {
        $pull: { userIds: targetUserId } as any,
        $set: { updatedAt: new Date() },
      },
    );

    res.json({ success: true, msg: "User removed" });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/users/search?q=... ──────────────────────────────────
export const searchUsers = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const q = ((req.query.q as string) || "").trim();
    if (q.length < 2) return res.json({ success: true, data: [] });

    const db = mongoose.connection.db;
    const cleanQuery = q.replace("@", "");

    const users = await db
      .collection("users")
      .find({
        _id: { $ne: new mongoose.Types.ObjectId(userId) },
        isActive: true,
        telegramId: { $regex: cleanQuery, $options: "i" },
      })
      .project({ name: 1, telegramUsername: 1, telegramId: 1 })
      .limit(20)
      .toArray();

    res.json({
      success: true,
      data: users.map((u: any) => ({
        _id: u._id.toString(),
        name: u.name,
        telegramUsername: u.telegramUsername,
        telegramId: u.telegramId,
      })),
    });
  } catch (error) {
    next(error);
  }
};
