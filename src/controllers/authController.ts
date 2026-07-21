import { Request, Response, NextFunction } from "express";
import User from "../models/User";
import { generateAuthTokens, verifyToken } from "../utils/jwt";
import { applyDefaultChannelsForNewUser } from "./defaultChannelsController";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import mongoose from "mongoose";
import bot from "../services/telegramBot";

const MAX_DEVICES = 3;
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
// ── POST /api/auth/telegram ─────────────────────────────────────

export const telegramAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { telegramId, telegramUsername, name, authToken } = req.body;
    const botSecret = process.env.BOT_AUTH_SECRET;
    if (!botSecret || authToken !== botSecret + "_" + telegramId) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid auth token" });
    }
    if (!telegramId) {
      return res
        .status(400)
        .json({ success: false, message: "telegramId required" });
    }

    let user = await User.findOne({ telegramId: telegramId.toString() });
    let isNew = false;

    if (!user) {
      user = await User.create({
        telegramId: telegramId.toString(),
        telegramUsername: telegramUsername || null,
        name: name || telegramUsername || "User",
        isActive: true,
        profileComplete: false,
        role: "user",
      });
      isNew = true;
    } else {
      user.telegramUsername = telegramUsername || user.telegramUsername;
      if (!user.isActive) {
        return res
          .status(401)
          .json({ success: false, message: "Account inactive" });
      }
    }

    user.lastLogin = new Date();
    await user.save();

    res.status(isNew ? 201 : 200).json({
      success: true,
      message: isNew ? "Registered successfully" : "Login successful",
      data: { user: user.toPublicJSON(), isNew },
    });

    if (isNew) applyDefaultChannelsForNewUser(user._id).catch(console.error);
  } catch (error) {
    next(error);
  }
};
// ── GET /api/auth/telegram/poll/:telegramId ─────────────────────
export const pollTelegramAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { sessionId } = req.params;
    const db = (mongoose as any).connection.db;

    const session = await db
      .collection("telegram_auth_sessions")
      .findOne({ sessionId, status: "confirmed" });

    if (!session) return res.json({ success: true, confirmed: false });

    await db.collection("telegram_auth_sessions").deleteOne({ sessionId });

    // بعد
    const user = await User.findById(session.userId);
    if (!user) return res.json({ success: true, confirmed: false });

    const deviceId: string | null = session.deviceId || null;

    if (deviceId) {
      await db.collection("user_sessions").deleteMany({
        userId: user._id.toString(),
        deviceId,
      });
    }

    const activeCount = await db
      .collection("user_sessions")
      .countDocuments({ userId: user._id.toString(), isActive: true });

    if (activeCount >= MAX_DEVICES) {
      return res.status(403).json({
        success: false,
        message: `You already have ${MAX_DEVICES} devices logged in. Please log out from another device first.`,
      });
    }

    const sid = new mongoose.Types.ObjectId().toString();
    const tokens = generateAuthTokens(user, sid);

    await db.collection("user_sessions").insertOne({
      _id: sid,
      userId: user._id.toString(),
      refreshTokenHash: hashToken(tokens.refreshToken),
      deviceName: "Unknown Device",
      platform: "Unknown",
      deviceId: deviceId || "",
      isActive: true,
      createdAt: new Date(),
      lastActive: new Date(),
    });

    res.json({
      success: true,
      confirmed: true,
      data: { user: user.toPublicJSON(), ...tokens, isNew: session.isNew },
    });
  } catch (error) {
    next(error);
  }
};
// ── POST /api/auth/telegram/session ─────────────────────────────
// بعد
export const createTelegramSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { deviceId } = req.body;
    const sessionId = crypto.randomBytes(16).toString("hex");
    const botUsername = process.env.TELEGRAM_BOT_USERNAME!;
    const db = (mongoose as any).connection.db;

    await db.collection("telegram_auth_sessions").insertOne({
      sessionId,
      status: "pending",
      deviceId: deviceId || null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const telegramLink = `https://t.me/${botUsername}?start=auth_${sessionId}`;

    res.json({
      success: true,
      data: { sessionId, telegramLink },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/auth/me ────────────────────────────────────────────
export const getMe = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = await User.findById((req as any).user.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    user.lastLogin = new Date();
    await user.save();

    const sessionId = (req as any).sessionId;
    if (sessionId) {
      (mongoose as any).connection.db
        .collection("user_sessions")
        .updateOne({ _id: sessionId }, { $set: { lastActive: new Date() } })
        .catch(() => {});
    }

    res
      .status(200)
      .json({ success: true, data: { user: user.toPublicJSON() } });
  } catch (error) {
    next(error);
  }
};
// ── PUT /api/auth/profile ───────────────────────────────────────
export const updateProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { name, email } = req.body;
    const user = await User.findById((req as any).user.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    if (name !== undefined && name.trim()) user.name = name.trim();

    await user.save();
    res.status(200).json({
      success: true,
      message: "Profile updated",
      data: { user: user.toPublicJSON() },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/logout ───────────────────────────────────────
export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const sessionId = (req as any).sessionId;
    if (sessionId) {
      await (mongoose as any).connection.db
        .collection("user_sessions")
        .updateOne({ _id: sessionId }, { $set: { isActive: false } });
    }
    res.status(200).json({ success: true, message: "Logout successful" });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/refresh ──────────────────────────────────────
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res
        .status(400)
        .json({ success: false, message: "Refresh token required" });

    let decoded: any;
    try {
      decoded = verifyToken(refreshToken);
    } catch {
      return res
        .status(401)
        .json({ success: false, message: "Invalid refresh token" });
    }

    const sid = decoded.sid;
    const db = (mongoose as any).connection.db;
    const session = sid
      ? await db
          .collection("user_sessions")
          .findOne({ _id: sid, isActive: true })
      : null;

    if (!session || session.refreshTokenHash !== hashToken(refreshToken)) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid refresh token" });
    }

    const user = await User.findById(decoded.id);
    if (!user)
      return res
        .status(401)
        .json({ success: false, message: "Invalid refresh token" });

    const tokens = generateAuthTokens(user, sid);
    await db.collection("user_sessions").updateOne(
      { _id: sid },
      {
        $set: {
          refreshTokenHash: hashToken(tokens.refreshToken),
          lastActive: new Date(),
        },
      },
    );

    res.status(200).json({ success: true, data: tokens });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/session/register
export const registerSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const sessionId = (req as any).sessionId;
    if (!sessionId) return res.json({ success: true });

    const { deviceName, platform, deviceId } = req.body;
    await (mongoose as any).connection.db.collection("user_sessions").updateOne(
      { _id: sessionId },
      {
        $set: {
          deviceName: deviceName || "Unknown Device",
          platform: platform || "Unknown",
          deviceId: deviceId || "",
          lastActive: new Date(),
        },
      },
    );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};
// GET /api/auth/sessions
export const getUserSessions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const currentSid = (req as any).sessionId;
    const db = (mongoose as any).connection.db;

    const sessions = await db
      .collection("user_sessions")
      .find({ userId, isActive: true })
      .sort({ lastActive: -1 })
      .toArray();

    res.json({
      success: true,
      data: sessions.map((s: any) => ({
        _id: s._id.toString(),
        deviceName: s.deviceName,
        platform: s.platform,
        lastActive: s.lastActive,
        createdAt: s.createdAt,
        isCurrent: s._id === currentSid,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/auth/sessions/:id
export const deleteUserSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const { id } = req.params;
    await (mongoose as any).connection.db
      .collection("user_sessions")
      .updateOne({ _id: id, userId }, { $set: { isActive: false } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/auth/telegram/refresh-username ─────────────────────
export const refreshTelegramUsername = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = await User.findById((req as any).user.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    if (!user.telegramId) {
      return res.status(400).json({
        success: false,
        message: "No Telegram account linked",
      });
    }

    try {
      const chat: any = await bot.getChat(user.telegramId);
      user.telegramUsername = chat.username || null;
      await user.save();
    } catch (err) {
      return res.status(502).json({
        success: false,
        message:
          "Could not fetch your Telegram info. Send /start to the bot first.",
      });
    }

    res.json({ success: true, data: { user: user.toPublicJSON() } });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/auth/account ────────────────────────────────────
export const deleteAccount = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = (mongoose as any).connection.db;

    const userChannels = await db
      .collection("user_channels")
      .find({ userId })
      .project({ channelUsername: 1 })
      .toArray();
    const channelUsernames = userChannels.map((c: any) => c.channelUsername);

    await Promise.all([
      db
        .collection("users")
        .deleteOne({ _id: new mongoose.Types.ObjectId(userId) }),
      db.collection("user_channels").deleteMany({ userId }),
      db.collection("user_favorites").deleteMany({ userId }),
      db.collection("user_playlists").deleteMany({ userId }),
      db.collection("user_sessions").deleteMany({ userId }),
      db.collection("user_deleted_default_channels").deleteMany({ userId }),
      db.collection("bot_songs").deleteMany({ userId }),
      db.collection("bot_connections").deleteMany({ userId }),
      db.collection("play_history").deleteMany({ userId }),
      db.collection("subscription_orders").deleteMany({ userId }),
    ]);

    // songs/channels رو فقط اگه هیچ یوزر دیگه‌ای نداره حذف کن
    for (const username of channelUsernames) {
      const otherUsers = await db
        .collection("user_channels")
        .countDocuments({ channelUsername: username });
      if (otherUsers === 0) {
        await db.collection("songs").deleteMany({ channelUsername: username });
        await db
          .collection("channels")
          .deleteOne({ channelUsername: username });
      }
    }

    res.status(200).json({ success: true, message: "Account deleted" });
  } catch (error) {
    next(error);
  }
};
