import mongoose from "mongoose";

type LogLevel = "info" | "warn" | "error";

interface LogMeta {
  telegramId?: string | null;
  telegramUsername?: string | null;
  userId?: string | null;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  [key: string]: any;
}

function userTag(meta?: LogMeta): string {
  if (meta?.telegramUsername) return `@${meta.telegramUsername}`;
  if (meta?.telegramId) return `tg:${meta.telegramId}`;
  if (meta?.userId) return `uid:${meta.userId}`;
  return "anon";
}

function consoleLine(level: LogLevel, message: string, meta?: LogMeta) {
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${userTag(meta)}]`;
  if (level === "error") console.error(prefix, message);
  else if (level === "warn") console.warn(prefix, message);
  else console.log(prefix, message);
}

async function persist(level: LogLevel, message: string, meta?: LogMeta) {
  try {
    if (mongoose.connection.readyState !== 1) return;
    const db = mongoose.connection.db;
    if (!db) return;
    await db.collection("logs").insertOne({
      level,
      message,
      meta: meta ?? {},
      createdAt: new Date(),
    });
  } catch {
  }
}

export const logger = {
  info(message: string, meta?: LogMeta) {
    consoleLine("info", message, meta);
    void persist("info", message, meta);
  },
  warn(message: string, meta?: LogMeta) {
    consoleLine("warn", message, meta);
    void persist("warn", message, meta);
  },
  error(message: string, meta?: LogMeta) {
    consoleLine("error", message, meta);
    void persist("error", message, meta);
  },
};