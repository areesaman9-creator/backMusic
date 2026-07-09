import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

export const recordPlay = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { songId } = req.body;
    if (!songId)
      return res.status(400).json({ success: false, msg: "songId required" });
    const db = mongoose.connection.db;
    await db
      .collection("play_history")
      .updateOne(
        { userId, songId },
        { $inc: { playCount: 1 }, $set: { lastPlayedAt: new Date() } },
        { upsert: true },
      );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const getMostPlayed = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const limit = Math.min(200, parseInt(req.query.limit as string) || 50);
    const db = mongoose.connection.db;
    const rows = await db
      .collection("play_history")
      .find({ userId })
      .sort({ playCount: -1 })
      .limit(limit)
      .project({ songId: 1 })
      .toArray();
    res.json({ success: true, data: rows.map((r) => r.songId) });
  } catch (error) {
    next(error);
  }
};

export const getRecentlyPlayed = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const limit = Math.min(200, parseInt(req.query.limit as string) || 50);
    const db = mongoose.connection.db;
    const rows = await db
      .collection("play_history")
      .find({ userId })
      .sort({ lastPlayedAt: -1 })
      .limit(limit)
      .project({ songId: 1 })
      .toArray();
    res.json({ success: true, data: rows.map((r) => r.songId) });
  } catch (error) {
    next(error);
  }
};
