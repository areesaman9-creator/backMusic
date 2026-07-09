/**
 * downloadsController.ts
 *
 * بعد از refactor:
 * - user_downloads collection حذف شده
 * - وضعیت دانلود فقط در Flutter state نگه داشته میشه
 * - این controller فقط disk cache سرور رو چک می‌کنه
 *
 * endpoint های باقی‌مونده:
 *   GET  /api/downloads/check/:fileId  ← فایل روی سرور هست؟
 */
import { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";

const AUDIO_CACHE_DIR =
  process.env.AUDIO_CACHE_DIR || path.join(process.cwd(), "audio_cache");

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

// ── GET /api/downloads/check/:fileId ──────────────────────────
// Flutter این رو صدا میزنه تا بدونه فایل روی سرور هست یا نه
export const checkServerCache = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { fileId } = req.params;
    const cached = isCached(fileId);
    let size = 0;
    if (cached) {
      try { size = fs.statSync(getCachePath(fileId)).size; } catch {}
    }
    res.json({ success: true, cached, size });
  } catch (error) {
    next(error);
  }
};
