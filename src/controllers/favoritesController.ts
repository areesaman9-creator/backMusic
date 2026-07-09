import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

// ── GET /api/favorites ─────────────────────────────────────────
// قبلاً: 2 query جدا + O(n²) sort در JS
// الان: یک aggregate — ترتیب هم حفظ می‌شه
export const getFavorites = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    const songs = await db
      .collection("user_favorites")
      .aggregate([
        { $match: { userId } },
        { $sort: { addedAt: -1 } },

        // convert songId string → ObjectId
        {
          $addFields: {
            _songObjId: {
              $cond: {
                if: { $regexMatch: { input: "$songId", regex: /^[a-f\d]{24}$/i } },
                then: { $toObjectId: "$songId" },
                else: null,
              },
            },
          },
        },

        // join song data
        {
          $lookup: {
            from: "songs",
            localField: "_songObjId",
            foreignField: "_id",
            as: "_song",
          },
        },

        // skip favorites whose song was deleted
        { $match: { "_song.0": { $exists: true } } },

        // flatten: replace root with the song document
        { $replaceRoot: { newRoot: { $arrayElemAt: ["$_song", 0] } } },
      ])
      .toArray();

    res.json({ success: true, data: songs });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/favorites/toggle ─────────────────────────────────
export const toggleFavorite = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { songId } = req.body;
    if (!songId)
      return res.status(400).json({ success: false, msg: "songId required" });

    const db = mongoose.connection.db;
    const existing = await db
      .collection("user_favorites")
      .findOne({ userId, songId });

    if (existing) {
      await db.collection("user_favorites").deleteOne({ _id: existing._id });
      return res.json({ success: true, liked: false });
    }

    // unique index on (userId, songId) prevents races
    await db
      .collection("user_favorites")
      .insertOne({ userId, songId, addedAt: new Date() });
    return res.json({ success: true, liked: true });
  } catch (error: any) {
    // duplicate key → already favorited
    if (error.code === 11000) {
      return res.json({ success: true, liked: true });
    }
    next(error);
  }
};
