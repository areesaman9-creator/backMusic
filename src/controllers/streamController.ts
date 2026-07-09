import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import telegramService from "../services/telegram";
import mongoose from "mongoose";
import { devNull } from "os";
import { extractEmbeddedArtwork } from "../utils/artwork";

// ── Disk cache ─────────────────────────────────────────────────
const AUDIO_CACHE_DIR =
  process.env.AUDIO_CACHE_DIR || path.join(process.cwd(), "audio_cache");

if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
  console.log(`📁 Audio cache directory created: ${AUDIO_CACHE_DIR}`);
}

function getCachePath(fileId: string): string {
  const safe = fileId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(AUDIO_CACHE_DIR, `${safe}.mp3`);
}

function isCached(fileId: string): boolean {
  try {
    return fs.statSync(getCachePath(fileId)).size > 0;
  } catch {
    return false;
  }
}

// ── JWT stream token (بدون DB) ─────────────────────────────────
const STREAM_SECRET =
  process.env.STREAM_TOKEN_SECRET || process.env.JWT_SECRET!;

interface StreamTokenPayload {
  fileId: string;
  channelUsername: string;
  messageId: number;
  userId: string;
}

function signStreamToken(payload: StreamTokenPayload): string {
  return jwt.sign(payload, STREAM_SECRET, { expiresIn: "1h" });
}

function verifyStreamToken(token: string): StreamTokenPayload | null {
  try {
    return jwt.verify(token, STREAM_SECRET) as StreamTokenPayload;
  } catch {
    return null;
  }
}

// ── POST /api/stream ───────────────────────────────────────────
export const streamSong = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { fileId, channelUsername, messageId, songId } = req.body;

    const { botSongId } = req.body;

    if (botSongId) {
      const db = mongoose.connection.db;
      const botSong = await db.collection("bot_songs").findOne({
        _id: new mongoose.Types.ObjectId(botSongId),
        userId,
      });
      if (!botSong) {
        return res
          .status(404)
          .json({ success: false, msg: "Bot song not found" });
      }

      // اگه کش شده بود مستقیم سرو کن
      if (isCached(botSong.fileId)) {
        const cachePath = getCachePath(botSong.fileId);
        const fileSize = fs.statSync(cachePath).size;
        const token = signStreamToken({
          fileId: botSong.fileId,
          channelUsername: "__bot__",
          messageId: botSong.messageId,
          userId,
        });
        res.set({
          "Content-Type": "audio/mpeg",
          "Content-Length": fileSize.toString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "X-Cached": "true",
          "X-Stream-Token": token,
          "X-Stream-Url": `/api/stream/${token}`,
        });
        return fs.createReadStream(cachePath).pipe(res);
      }

      // دانلود از تلگرام با fileId مستقیم
      let handle;
      try {
        handle = await telegramService.prepareStreamDownloadByFileId(
          botSong.fileId,
          userId,
        );
      } catch (err: any) {
        return res.status(502).json({ success: false, msg: err.message });
      }

      const token = signStreamToken({
        fileId: botSong.fileId,
        channelUsername: "__bot__",
        messageId: botSong.messageId,
        userId,
      });

      res.set({
        "Content-Type": "audio/mpeg",
        ...(handle.totalSize > 0
          ? { "Content-Length": handle.totalSize.toString() }
          : {}),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Stream-Token": token,
        "X-Stream-Url": `/api/stream/${token}`,
      });

      const cachePath = getCachePath(botSong.fileId);
      const tempPath = `${cachePath}.part`;
      const fileStream = fs.createWriteStream(tempPath);
      let clientGone = false;
      req.on("close", () => {
        clientGone = true;
      });

      try {
        for await (const chunk of handle.chunks) {
          fileStream.write(chunk);
          if (!clientGone) {
            const ok = res.write(chunk);
            if (!ok) await new Promise((resolve) => res.once("drain", resolve));
          }
        }
        await new Promise<void>((resolve, reject) => {
          fileStream.end((err?: Error) => (err ? reject(err) : resolve()));
        });
        fs.renameSync(tempPath, cachePath);
        if (!clientGone) res.end();
        _upgradeArtworkFromId3(
          cachePath,
          { _id: botSong._id },
          "bot_songs",
          db,
        ).catch(() => {});
      } catch (err) {
        fileStream.destroy();
        try {
          fs.unlinkSync(tempPath);
        } catch {}
        if (!res.headersSent)
          res.status(502).json({ success: false, msg: "Streaming failed" });
        else res.end();
      }
      return;
    }

    if (!fileId || !channelUsername || !messageId) {
      return res.status(400).json({
        success: false,
        msg: "fileId, channelUsername, messageId required",
      });
    }

    const db = mongoose.connection.db;

    // ── حالت ۱: قبلاً کش شده — مثل قبل ──────────────────────────
    if (isCached(fileId)) {
      console.log(`✅ [stream] Serving from disk cache: ${fileId}`);
      const cachePath = getCachePath(fileId);
      const fileSize = fs.statSync(cachePath).size;

      const token = signStreamToken({
        fileId,
        channelUsername,
        messageId: parseInt(messageId),
        userId,
      });
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Length": fileSize.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Cached": "true",
        "X-File-Size": fileSize.toString(),
        "X-Stream-Token": token,
        "X-Stream-Url": `/api/stream/${token}`,
        "X-Expires-At": expiresAt.toISOString(),
      });
      return fs.createReadStream(cachePath).pipe(res);
    }

    // ── حالت ۲: کش نیست — همزمان استریم به کلاینت + نوشتن دیسک ──
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

    const token = signStreamToken({
      fileId,
      channelUsername,
      messageId: parseInt(messageId),
      userId,
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    res.set({
      "Content-Type": "audio/mpeg",
      ...(handle.totalSize > 0
        ? { "Content-Length": handle.totalSize.toString() }
        : {}),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Cached": "false",
      "X-Stream-Token": token,
      "X-Stream-Url": `/api/stream/${token}`,
      "X-Expires-At": expiresAt.toISOString(),
    });

    const cachePath = getCachePath(fileId);
    const tempPath = `${cachePath}.part`; // اول روی temp بنویس
    const fileStream = fs.createWriteStream(tempPath);

    let clientGone = false;
    req.on("close", () => {
      clientGone = true;
    });

    try {
      for await (const chunk of handle.chunks) {
        fileStream.write(chunk);

        if (!clientGone) {
          const ok = res.write(chunk);
          if (!ok) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end((err?: Error) => (err ? reject(err) : resolve()));
      });

      fs.renameSync(tempPath, cachePath);

      if (!clientGone) res.end();
      _upgradeArtworkFromId3(
        cachePath,
        { channelUsername: channelUsername.replace("@", ""), messageId: parseInt(messageId) },
        "songs",
        db,
      ).catch(() => {});
    } catch (err) {
      fileStream.destroy();
      try {
        fs.unlinkSync(tempPath);
      } catch {}
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

// ── GET /api/stream/:token ─────────────────────────────────────
export const streamByToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { token } = req.params;

    // verify JWT — بدون DB lookup
    const payload = verifyStreamToken(token);
    if (!payload) {
      return res
        .status(404)
        .json({ success: false, msg: "Token expired or invalid" });
    }

    if (!isCached(payload.fileId)) {
      return res
        .status(404)
        .json({ success: false, msg: "Audio not in disk cache" });
    }

    const cachePath = getCachePath(payload.fileId);
    const fileSize = fs.statSync(cachePath).size;
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.set({
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize.toString(),
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      });
      res.status(206);
      fs.createReadStream(cachePath, { start, end }).pipe(res);
    } else {
      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Length": fileSize.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(cachePath).pipe(res);
    }
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/check/:fileId ──────────────────────────────
export const checkDiskCache = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { fileId } = req.params;
    const cached = isCached(fileId);
    let size = 0;
    if (cached) {
      try {
        size = fs.statSync(getCachePath(fileId)).size;
      } catch {}
    }
    res.json({ success: true, cached, size });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/token/:songId ──────────────────────────────
export const issueStreamToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { songId } = req.params;
    const db = mongoose.connection.db;

    const song = await db
      .collection("telegram_songs")
      .findOne({ _id: new mongoose.Types.ObjectId(songId) });

    if (!song) {
      return res.status(404).json({ success: false, msg: "Song not found" });
    }

    if (!isCached(song.fileId)) {
      return res.status(404).json({
        success: false,
        msg: "Audio not cached — use POST /api/stream first",
      });
    }

    const token = signStreamToken({
      fileId: song.fileId,
      channelUsername: song.channelUsername,
      messageId: song.messageId,
      userId,
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    res.json({ success: true, streamUrl: `/api/stream/${token}`, expiresAt });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/stream/admin/stats ────────────────────────────────
export const getCacheStats = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let totalSize = 0;
    let fileCount = 0;

    try {
      for (const f of fs.readdirSync(AUDIO_CACHE_DIR)) {
        if (!f.endsWith(".mp3")) continue;
        try {
          totalSize += fs.statSync(path.join(AUDIO_CACHE_DIR, f)).size;
          fileCount++;
        } catch {}
      }
    } catch {}

    res.json({
      success: true,
      data: {
        fileCount,
        totalSize,
        totalSizeFormatted: _fmtBytes(totalSize),
        cacheDir: AUDIO_CACHE_DIR,
      },
    });
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
      .collection("telegram_songs")
      .findOne({ _id: new mongoose.Types.ObjectId(songId) });

    if (!song || (song.thumbnail && song.thumbnail !== devNull)) return;

    const thumbnail = await telegramService.downloadSongThumbnail(
      song.channelUsername,
      song.messageId,
      userId,
    );

    await db
      .collection("telegram_songs")
      .updateOne(
        { _id: new mongoose.Types.ObjectId(songId) },
        { $set: { thumbnail: thumbnail || null } },
      );
  } catch {}
}

function _fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function _upgradeArtworkFromId3(
  cachePath: string,
  matchQuery: Record<string, any>,
  collectionName: "songs" | "bot_songs",
  db: any,
): Promise<void> {
  try {
    const artwork = await extractEmbeddedArtwork(cachePath);
    if (!artwork) return;
    await db
      .collection(collectionName)
      .updateOne(matchQuery, { $set: { thumbnail: artwork } });
    console.log(
      `🖼️  [artwork] Upgraded from ID3: ${JSON.stringify(matchQuery)}`,
    );
  } catch (err) {
    console.error("_upgradeArtworkFromId3 failed:", err);
  }
}

