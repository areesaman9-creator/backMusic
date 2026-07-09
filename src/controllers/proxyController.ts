import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import telegramService from "../services/telegram";

// ── GET /api/proxy ─────────────────────────────────────────────
export const getProxy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    // ← از users.proxy می‌خونه، نه collection جدا
    const user = await db
      .collection("users")
      .findOne(
        { _id: new mongoose.Types.ObjectId(userId) },
        { projection: { proxy: 1 } }
      );

    const proxy = user?.proxy;

    res.json({
      success: true,
      data: {
        proxyType:     proxy?.type     ?? "none",
        proxyHost:     proxy?.host     ?? "",
        proxyPort:     proxy?.port     ?? 0,
        proxyUsername: proxy?.username ?? "",
        proxyPassword: proxy?.password ?? "",
        proxySecret:   proxy?.secret   ?? "",
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/proxy ────────────────────────────────────────────
export const setProxy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const { proxyType, proxyHost, proxyPort, proxyUsername, proxyPassword, proxySecret } = req.body;
    const db = mongoose.connection.db;

    if (!proxyType || proxyType === "none") {
      // proxy غیرفعال — فیلد رو حذف کن
      await db.collection("users").updateOne(
        { _id: new mongoose.Types.ObjectId(userId) },
        { $unset: { proxy: "" } }
      );
      return res.json({ success: true, msg: "Proxy disabled" });
    }

    // proxy فعال — embed در users
    await db.collection("users").updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      {
        $set: {
          proxy: {
            type:     proxyType,
            host:     proxyHost     || "",
            port:     proxyPort     || 0,
            username: proxyUsername || "",
            password: proxyPassword || "",
            secret:   proxySecret   || "",
          },
        },
      }
    );

    res.json({ success: true, msg: "Proxy settings saved" });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/proxy/test ───────────────────────────────────────
export const testProxy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id.toString();
    const result = await telegramService.testConnection(userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
};
