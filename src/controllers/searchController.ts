import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { buildTitleSearchQuery, buildArtistSearchQuery } from "../utils/search";
import { signThumbnailUrl } from "../utils/thumbnailToken";

// ── GET /api/search/users?q=... ──────────────────────────────────
export const searchUsersGlobal = async (
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
        isActive: true,
        telegramUsername: { $regex: cleanQuery, $options: "i" },
      })
      .project({ name: 1, telegramUsername: 1, telegramId: 1, isPrivate: 1 })
      .limit(20)
      .toArray();

    res.json({
      success: true,
      data: users.map((u: any) => ({
        _id: u._id.toString(),
        name: u.name,
        telegramUsername: u.telegramUsername,
        telegramId: u.telegramId,
        isPrivate: u.isPrivate === true,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/search/users/:id/profile ────────────────────────────
export const getUserPublicProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const db = mongoose.connection.db;
    let objId: mongoose.Types.ObjectId;
    try {
      objId = new mongoose.Types.ObjectId(id);
    } catch {
      return res.status(400).json({ success: false, msg: "Invalid user id" });
    }

    const user = await db
      .collection("users")
      .findOne(
        { _id: objId },
        {
          projection: {
            name: 1,
            telegramUsername: 1,
            telegramId: 1,
            isPrivate: 1,
          },
        },
      );
    if (!user)
      return res.status(404).json({ success: false, msg: "User not found" });

    if (user.isPrivate === true) {
      return res.json({
        success: true,
        locked: true,
        data: {
          _id: user._id.toString(),
          name: user.name,
          telegramUsername: user.telegramUsername,
        },
      });
    }

    const userIdStr = user._id.toString();

    const [userChannels, playlists] = await Promise.all([
      db
        .collection("user_channels")
        .find({ userId: userIdStr, isDefault: { $ne: true } })
        .project({ channelUsername: 1, channelDisplayName: 1 })
        .toArray(),
      db
        .collection("user_playlists")
        .find({ ownerId: userIdStr, isPublic: true })
        .project({ name: 1, songIds: 1 })
        .toArray(),
    ]);

    const usernames = userChannels.map((c: any) => c.channelUsername);
    const channelDocs = usernames.length
      ? await db
          .collection("channels")
          .find({ channelUsername: { $in: usernames } })
          .project({
            channelUsername: 1,
            channelName: 1,
            photoUrl: 1,
            status: 1,
            songsCount: 1,
          })
          .toArray()
      : [];
    const channelMap = new Map(
      channelDocs.map((c: any) => [c.channelUsername, c]),
    );

    const channels = userChannels.map((uc: any) => {
      const ch: any = channelMap.get(uc.channelUsername) || {};
      return {
        channelUsername: uc.channelUsername,
        channelName: ch.channelName || uc.channelUsername,
        channelDisplayName: uc.channelDisplayName,
        photoUrl: ch.photoUrl || null,
        status: ch.status || "pending",
        songsCount: ch.songsCount || 0,
      };
    });

    res.json({
      success: true,
      locked: false,
      data: {
        _id: userIdStr,
        name: user.name,
        telegramUsername: user.telegramUsername,
        channels,
        playlists: playlists.map((p: any) => ({
          _id: p._id,
          name: p.name,
          songsCount: (p.songIds || []).length,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/search/songs?q=... (فقط title) ──────────────────────
export const searchSongsByTitle = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const q = ((req.query.q as string) || "").trim();
    const page = Math.max(1, parseInt((req.query.page as string) || "1"));
    const limit = Math.min(100, parseInt((req.query.limit as string) || "30"));
    if (!q) return res.json({ success: true, data: [], total: 0 });

    const db = mongoose.connection.db;
    const { clauses } = buildTitleSearchQuery(q);
    if (clauses.length === 0)
      return res.json({ success: true, data: [], total: 0 });

    const query: any = { $and: clauses };
    const skip = (page - 1) * limit;

    const [songs, total] = await Promise.all([
      db
        .collection("songs")
        .find(query, {
          projection: {
            thumbnail: 0,
            searchWords: 0,
            searchPrefixes: 0,
            titleWords: 0,
            titlePrefixes: 0,
            artistWords: 0,
            artistPrefixes: 0,
          },
        })
        .sort({ messageDate: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection("songs").countDocuments(query),
    ]);

    const usernames = [...new Set(songs.map((s: any) => s.channelUsername))];
    const channelDocs = usernames.length
      ? await db
          .collection("channels")
          .find({ channelUsername: { $in: usernames } })
          .project({ channelUsername: 1, channelName: 1 })
          .toArray()
      : [];
    const nameMap = new Map(
      channelDocs.map((c: any) => [c.channelUsername, c.channelName]),
    );

    const data = songs.map((s: any) => ({
      ...s,
      channelName: nameMap.get(s.channelUsername) || s.channelUsername,
      thumbnail: signThumbnailUrl(s._id.toString(), userId),
    }));

    res.json({
      success: true,
      data,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};



// ── GET /api/search/artists?q= ─────────
export const searchArtists = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const q = ((req.query.q as string) || "").trim();
    if (!q) return res.json({ success: true, data: [] });

    const db = mongoose.connection.db;
    const { clauses } = buildArtistSearchQuery(q);
    if (clauses.length === 0) return res.json({ success: true, data: [] });

    const query: any = { $and: clauses };

    const songs = await db
      .collection("songs")
      .find(query, {
        projection: {
          thumbnail: 0,
          searchWords: 0,
          searchPrefixes: 0,
          titleWords: 0,
          titlePrefixes: 0,
          artistWords: 0,
          artistPrefixes: 0,
        },
      })
      .sort({ channelUsername: 1, messageDate: -1 })
      .limit(500)
      .toArray();

    const usernames = [...new Set(songs.map((s: any) => s.channelUsername))];
    const channelDocs = usernames.length
      ? await db
          .collection("channels")
          .find({ channelUsername: { $in: usernames } })
          .project({ channelUsername: 1, channelName: 1 })
          .toArray()
      : [];
    const nameMap = new Map(
      channelDocs.map((c: any) => [c.channelUsername, c.channelName]),
    );

    const grouped = new Map<string, any[]>();
    for (const s of songs) {
      const list = grouped.get(s.channelUsername) || [];
    list.push({
        ...s,
        channelName: nameMap.get(s.channelUsername) || s.channelUsername,
        thumbnail: signThumbnailUrl(s._id.toString(), userId),
      });
      grouped.set(s.channelUsername, list);
    }

    const data = Array.from(grouped.entries()).map(
      ([channelUsername, songsInChannel]) => ({
        channelUsername,
        channelName: nameMap.get(channelUsername) || channelUsername,
        songs: songsInChannel,
      }),
    );

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/search/playlists?q=... (فقط پابلیک) ──────────────────
export const searchPublicPlaylists = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const q = ((req.query.q as string) || "").trim();
    const db = mongoose.connection.db;

    const match: any = { isPublic: true };
    if (q) match.name = { $regex: q, $options: "i" };

    const playlists = await db
      .collection("user_playlists")
      .aggregate([
        { $match: match },
        { $sort: { updatedAt: -1 } },
        { $limit: 50 },
        {
          $addFields: { songsCount: { $size: { $ifNull: ["$songIds", []] } } },
        },
      ])
      .toArray();

    res.json({ success: true, data: playlists });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/search/channels?q=... ────────────────────────────────
export const searchChannelsGlobal = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const q = ((req.query.q as string) || "").trim();
    if (!q) return res.json({ success: true, data: [] });
    const db = mongoose.connection.db;

    const channels = await db
      .collection("channels")
      .find({
        $or: [
          { channelName: { $regex: q, $options: "i" } },
          { channelUsername: { $regex: q, $options: "i" } },
        ],
      })
      .project({
        channelUsername: 1,
        channelName: 1,
        photoUrl: 1,
        status: 1,
        songsCount: 1,
      })
      .limit(30)
      .toArray();

    res.json({ success: true, data: channels });
  } catch (error) {
    next(error);
  }
};
