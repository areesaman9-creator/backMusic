import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

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
        { $match: { userId } },
        { $sort: { updatedAt: -1 } },
        // always derive songsCount from the actual array — never trust the stored field
        {
          $addFields: {
            songsCount: { $size: { $ifNull: ["$songIds", []] } },
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
    const { name, description } = req.body;
    if (!name)
      return res.status(400).json({ success: false, msg: "name required" });

    const db = mongoose.connection.db;

    const existing = await db
      .collection("user_playlists")
      .findOne({ userId, name });
    if (existing)
      return res
        .status(400)
        .json({ success: false, msg: "Playlist name already exists" });

    const newPlaylist = {
      userId,
      name,
      description: description || null,
      coverImage: null,
      songIds: [], // ← source of truth; songsCount derived from this
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("user_playlists").insertOne(newPlaylist);
    res.status(201).json({
      success: true,
      msg: "Playlist created",
      data: { _id: result.insertedId, ...newPlaylist, songsCount: 0 },
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
    const { name, description } = req.body;

    if (!name || !name.toString().trim())
      return res.status(400).json({ success: false, msg: "name required" });

    const db = mongoose.connection.db;
    const trimmedName = name.toString().trim();

    const existing = await db.collection("user_playlists").findOne({
      userId,
      name: trimmedName,
      _id: { $ne: new mongoose.Types.ObjectId(playlistId) },
    });
    if (existing)
      return res
        .status(400)
        .json({ success: false, msg: "Playlist name already exists" });

    const result = await db.collection("user_playlists").updateOne(
      { _id: new mongoose.Types.ObjectId(playlistId), userId },
      {
        $set: {
          name: trimmedName,
          ...(description !== undefined ? { description } : {}),
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });

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

    const result = await db.collection("user_playlists").deleteOne({
      _id: new mongoose.Types.ObjectId(playlistId),
      userId,
    });

    if (result.deletedCount === 0)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });

    res.json({ success: true, msg: "Playlist deleted" });
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
      userId,
    });
    if (!playlist)
      return res
        .status(404)
        .json({ success: false, msg: "Playlist not found" });

    const songIds = playlist.songIds ?? [];
    const realCount = songIds.length; // ← always accurate
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

    // fetch from both regular songs and bot songs
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

    const songMap = new Map(songs.map((s) => [s._id.toString(), s]));

    // normalize bot_songs to look like regular song docs
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
      .filter(Boolean);

    res.json({
      success: true,
      data: ordered,
      playlist: {
        _id: playlist._id,
        name: playlist.name,
        songsCount: realCount, // ← derived, never stale
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
        userId,
        songIds: { $ne: songId }, // only add if not already present
      },
      {
        $push: { songIds: songId } as any,
        $set: { updatedAt: new Date() },
        // songsCount intentionally NOT updated — derived from songIds.length
      },
    );

    if (result.matchedCount === 0) {
      // either not found or already contains the song
      const exists = await db.collection("user_playlists").findOne({
        _id: new mongoose.Types.ObjectId(playlistId),
        userId,
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
      { _id: new mongoose.Types.ObjectId(playlistId), userId },
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
        { _id: new mongoose.Types.ObjectId(playlistId), userId },
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
