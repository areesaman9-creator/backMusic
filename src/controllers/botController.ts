import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import {
  generateConnectionCode,
  broadcastMessage,
} from "../services/telegramBot";
import { signThumbnailUrl } from "../utils/thumbnailToken";

export const generateCode = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const code = generateConnectionCode(userId);
    res.json({ success: true, data: { code, expiresInMinutes: 10 } });
  } catch (error) {
    next(error);
  }
};

export const getBotStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    const connection = await db
      .collection("bot_connections")
      .findOne({ userId });

    res.json({
      success: true,
      data: {
        connected: !!connection?.isActive,
        telegramUsername: connection?.telegramUsername || null,
        connectedAt: connection?.connectedAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const disconnectBot = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    await db
      .collection("bot_connections")
      .updateOne({ userId }, { $set: { isActive: false } });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const getBotSongs = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(200, parseInt(limit as string));
    const skip = (pageNum - 1) * limitNum;
    const db = mongoose.connection.db;

    const [songs, total] = await Promise.all([
      db
        .collection("bot_songs")
        .find({ userId })
        .sort({ receivedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
      db.collection("bot_songs").countDocuments({ userId }),
    ]);

    // فرمت رو مثل songs معمولی کن تا Flutter بتونه Song.fromJson بزنه
    const formatted = songs.map((s) => ({
      _id: s._id.toString(),
      channelDbId: s._id.toString(),
      channelUsername: s.channelUsername,
      channelName: "Bot Inbox",
      title: s.title,
      artist: s.artist,
      duration: s.duration,
      fileId: s.fileId,
      fileSize: s.fileSize,
      thumbnail: signThumbnailUrl(s._id.toString()),
      messageId: s.messageId,
      isFavorite: false,
    }));

    res.json({
      success: true,
      data: formatted,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      hasMore: pageNum < Math.ceil(total / limitNum),
    });
  } catch (error) {
    next(error);
  }
};

export const refreshBotSongThumbnails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    const songs = await db
      .collection("bot_songs")
      .find({ userId, thumbnail: null })
      .toArray();

    res.json({
      success: true,
      message: `${songs.length} songs need thumbnail refresh. Re-send them to the bot to update.`,
      count: songs.length,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteBotSong = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id } = req.params;
    const db = mongoose.connection.db;

    await db.collection("bot_songs").deleteOne({
      _id: new mongoose.Types.ObjectId(id),
      userId,
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const adminBroadcast = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { message, targetUserIds } = req.body;
    if (!message?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "message is required" });
    }
    const result = await broadcastMessage(message, targetUserIds);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
