import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import connectDB from "./config/database";
import routes from "./routes";
import { errorHandler, notFound } from "./middleware/errorHandler";
import telegramBot from "./services/telegramBot";
import telegramService from "./services/telegram";

const app = express();

// MongoDB
connectDB();

app.set("trust proxy", 2);

// Security
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Rate Limiting
app.use(
  "/api/",
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"),
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "200"),
    message: { success: false, message: "Too many requests, try again later." },
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// CORS
app.use(cors({ origin: process.env.CORS_ORIGIN || "*", credentials: true }));

// Body Parser
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ── Health Check ────────────────────────────────────────────────
const MONGO_STATES: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

function formatUptime(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d ? `${d}d` : null, h ? `${h}h` : null, m ? `${m}m` : null, `${sec}s`]
    .filter(Boolean)
    .join(" ");
}

app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  const mongoState = mongoose.connection.readyState;
  const mongoConnected = mongoState === 1;

  let telegramClientConnected = false;
  try {
    telegramClientConnected = telegramService.isConnected();
  } catch {}

  let botPolling = false;
  try {
    botPolling = telegramBot.isPolling();
  } catch {}

  const overallOk = mongoConnected;

  res.status(overallOk ? 200 : 503).json({
    success: overallOk,
    message: overallOk ? "Server is running" : "Server is degraded",
    timestamp: new Date().toISOString(),
    uptime: {
      seconds: Math.floor(process.uptime()),
      human: formatUptime(process.uptime()),
    },
    services: {
      database: {
        connected: mongoConnected,
        status: MONGO_STATES[mongoState] ?? "unknown",
        name: mongoose.connection.name || null,
        host: mongoose.connection.host || null,
      },
      telegram: {
        userClientConnected: telegramClientConnected,
        botPolling,
      },
    },
    system: {
      nodeVersion: process.version,
      env: process.env.NODE_ENV || "development",
      pid: process.pid,
      memoryMb: {
        rss: +(mem.rss / 1024 / 1024).toFixed(1),
        heapUsed: +(mem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotal: +(mem.heapTotal / 1024 / 1024).toFixed(1),
      },
    },
  });
});

// API Routes
app.use("/api", routes);

// Error Handlers
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`🌍 Mode: ${process.env.NODE_ENV || "development"}`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
  console.log(`📡 API:    http://localhost:${PORT}/api`);
});

process.on("unhandledRejection", (err: any) => {
  console.error(`❌ Unhandled Rejection: ${err.message}`);
  process.exit(1);
});

// ── Graceful Shutdown ────────────────────────────────────────────
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log(`⚠️  ${signal} received again — shutdown already in progress`);
    return;
  }
  isShuttingDown = true;

  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

  const forceExitTimer = setTimeout(() => {
    console.error(
      `⏱️  Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    console.log("🔌 Closing HTTP server (no new requests accepted)...");
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    console.log("✅ HTTP server closed");

    console.log("🤖 Stopping Telegram bot polling...");
    try {
      await telegramBot.stopPolling();
      console.log("✅ Telegram bot polling stopped");
    } catch (e: any) {
      console.error("⚠️  Failed to stop Telegram bot polling:", e.message);
    }

    console.log("📡 Disconnecting Telegram MTProto client...");
    try {
      if (telegramService.isConnected()) {
        await telegramService.disconnect();
      }
      console.log("✅ Telegram MTProto client disconnected");
    } catch (e: any) {
      console.error("⚠️  Failed to disconnect Telegram client:", e.message);
    }

    console.log("🍃 Disconnecting MongoDB...");
    try {
      await mongoose.disconnect();
      console.log("✅ MongoDB disconnected");
    } catch (e: any) {
      console.error("⚠️  Failed to disconnect MongoDB:", e.message);
    }

    clearTimeout(forceExitTimer);
    console.log("👋 Graceful shutdown complete.");
    process.exit(0);
  } catch (err: any) {
    console.error("❌ Error during graceful shutdown:", err.message);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
