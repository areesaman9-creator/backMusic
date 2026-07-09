import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import connectDB from "./config/database";
import routes from "./routes";
import { errorHandler, notFound } from "./middleware/errorHandler";
import "./services/telegramBot";

const app = express();

// اتصال به MongoDB
connectDB();

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
  })
);

// CORS
app.use(cors({ origin: process.env.CORS_ORIGIN || "*", credentials: true }));

// Body Parser
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Health Check
app.get("/health", (req, res) => {
  res.json({ success: true, message: "Server is running", timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api", routes);

// Error Handlers
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`🌍 Mode: ${process.env.NODE_ENV || "development"}`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
  console.log(`📡 API:    http://localhost:${PORT}/api`);
  console.log(`\n📋 Endpoints:`);
  console.log(`  POST /api/auth/register`);
  console.log(`  POST /api/auth/login`);
  console.log(`  GET  /api/channels`);
  console.log(`  GET  /api/songs`);
  console.log(`  POST /api/stream`);
  console.log(`  GET  /api/stream/:token\n`);
});

process.on("unhandledRejection", (err: any) => {
  console.error(`❌ Unhandled Rejection: ${err.message}`);
  process.exit(1);
});

export default app;
