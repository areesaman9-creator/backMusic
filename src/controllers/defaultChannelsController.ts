import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { addChannelForUser } from "./channelsController";

// ── Default channels از env یا فایل می‌خونه (نه DB) ───────────
//
// در .env بذار:
// DEFAULT_CHANNELS='[{"username":"music_channel","name":"Music Channel"}]'
//
// یا فایل default_channels.json در root پروژه

function getDefaultChannels(): Array<{ username: string; name: string }> {
  // اول env رو چک کن
  if (process.env.DEFAULT_CHANNELS) {
    try {
      return JSON.parse(process.env.DEFAULT_CHANNELS);
    } catch (e) {
      console.error("❌ DEFAULT_CHANNELS env var is not valid JSON:", e);
    }
  }

  // بعد فایل رو چک کن
  try {
    const fs = require("fs");
    const path = require("path");
    const filePath = path.join(process.cwd(), "default_channels.json");
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.error("❌ Could not read default_channels.json:", e);
  }

  return [];
}

// ── POST /api/admin/default-channels/apply-all ─────────────────
// چنل‌های پیش‌فرض رو به همه کاربرهای موجود که هنوز ندارن اضافه می‌کنه
export const applyDefaultChannelsToAllUsers = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const defaults = getDefaultChannels();

    if (defaults.length === 0) {
      return res.json({
        success: true,
        msg: "No default channels configured",
        added: 0,
        usersProcessed: 0,
      });
    }

    const db = mongoose.connection.db;
    const users = await db
      .collection("users")
      .find({ isActive: true })
      .project({ _id: 1 })
      .toArray();

    let added = 0;
    for (const user of users) {
      const userId = user._id.toString();

      const [existingChannels, deletedDefaults] = await Promise.all([
        db
          .collection("user_channels")
          .find({ userId })
          .project({ channelUsername: 1 })
          .toArray(),
        db
          .collection("user_deleted_default_channels")
          .find({ userId })
          .project({ channelUsername: 1 })
          .toArray(),
      ]);

      const existingUsernames = new Set(
        existingChannels.map((c: any) => c.channelUsername),
      );
      const deletedUsernames = new Set(
        deletedDefaults.map((d: any) => d.channelUsername),
      );

      for (const dc of defaults) {
        if (existingUsernames.has(dc.username)) continue;
        if (deletedUsernames.has(dc.username)) continue; // ← عمداً حذف کرده
        const result = await addChannelForUser(
          userId,
          dc.username,
          dc.name,
          db,
        );
        if (result.added) added++;
      }
    }

    res.json({
      success: true,
      msg: "Applied default channels",
      added,
      usersProcessed: users.length,
    });
  } catch (error) {
    next(error);
  }
};

export async function applyDefaultChannelsForNewUser(
  userId: any,
): Promise<void> {
  try {
    const db = mongoose.connection.db;
    const defaults = await db.collection("default_channels").find().toArray();

    for (const dc of defaults) {
      await addChannelForUser(
        userId.toString(),
        dc.channelUsername,
        dc.channelName,
        db,
      );
    }
  } catch (err) {
    console.error("applyDefaultChannelsForNewUser failed:", err);
  }
}

// ── GET /api/admin/default-channels ────────────────────────────
// فقط برای نمایش در admin panel — از config می‌خونه
export const listDefaultChannels = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const channels = getDefaultChannels();
    res.json({ success: true, data: channels });
  } catch (error) {
    next(error);
  }
};
