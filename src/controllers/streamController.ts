import { Request, Response, NextFunction } from "express";
import telegramService from "../services/telegram";
import mongoose from "mongoose";

// ── POST /api/stream ───────────────────────────────────────────
export const streamSong = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { fileId, channelUsername, messageId, songId, botSongId } = req.body;
    const db = mongoose.connection.db;

    if (botSongId) {
      const botSong = await db.collection("bot_songs").findOne({
        _id: new mongoose.Types.ObjectId(botSongId),
        userId,
      });
      if (!botSong) {
        return res
          .status(404)
          .json({ success: false, msg: "Bot song not found" });
      }

     let handle;
      try {
        handle = await telegramService.prepareStreamDownload(
          botSong.fileId,
          botSong.channelUsername,
          botSong.messageId,
          userId,
        );
      } catch (err: any) {
        return res.status(502).json({ success: false, msg: err.message });
      }

      res.set({
        "Content-Type": "audio/mpeg",
        ...(handle.totalSize > 0
          ? { "Content-Length": handle.totalSize.toString() }
          : {}),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });

      let clientGone = false;
      req.on("close", () => {
        clientGone = true;
      });

      try {
        for await (const chunk of handle.chunks) {
          if (clientGone) break;
          const ok = res.write(chunk);
          if (!ok) await new Promise((resolve) => res.once("drain", resolve));
        }
        if (!clientGone) res.end();
      } catch (err) {
        console.error(
          `❌ [stream] Streaming failed for bot song ${botSongId}:`,
          err,
        );
        if (!res.headersSent) {
          res.status(502).json({ success: false, msg: "Streaming failed" });
        } else {
          res.end();
        }
      }
      return;
    }

    if (!fileId || !channelUsername || !messageId) {
      return res.status(400).json({
        success: false,
        msg: "fileId, channelUsername, messageId required",
      });
    }

    console.log(`📥 [stream] Streaming from Telegram: ${fileId}`);

    if (songId) {
      _downloadThumbnailBg(songId, userId, db).catch(console.error);
    }

    let handle;
    try {
      handle = await telegramService.prepareStreamDownload(
        fileId,
        channelUsername.replace("@", ""),
        parseInt(messageId),
        userId,
      );
    } catch (err: any) {
      return res.status(502).json({
        success: false,
        msg: err.message || "Telegram download failed",
      });
    }

    res.set({
      "Content-Type": "audio/mpeg",
      ...(handle.totalSize > 0
        ? { "Content-Length": handle.totalSize.toString() }
        : {}),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });

    let clientGone = false;
    req.on("close", () => {
      clientGone = true;
    });

    try {
      for await (const chunk of handle.chunks) {
        if (clientGone) break;
        const ok = res.write(chunk);
        if (!ok) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      if (!clientGone) res.end();
    } catch (err) {
      console.error(`❌ [stream] Streaming failed for ${fileId}:`, err);
      if (!res.headersSent) {
        res.status(502).json({ success: false, msg: "Streaming failed" });
      } else {
        res.end();
      }
    }
  } catch (error) {
    next(error);
  }
};

// ── Helpers ────────────────────────────────────────────────────
async function _downloadThumbnailBg(
  songId: string,
  userId: string,
  db: any,
): Promise<void> {
  try {
    const song = await db
      .collection("songs")
      .findOne({ _id: new mongoose.Types.ObjectId(songId) });

    if (!song || song.thumbnail) return;

    const thumbnail = await telegramService.downloadSongThumbnail(
      song.channelUsername,
      song.messageId,
      userId,
    );

    await db
      .collection("songs")
      .updateOne(
        { _id: new mongoose.Types.ObjectId(songId) },
        { $set: { thumbnail: thumbnail || null } },
      );
  } catch {}
}