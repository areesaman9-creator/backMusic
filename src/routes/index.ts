import { Router } from "express";
import {
  telegramAuth,
  getMe,
  updateProfile,
  logout,
  refreshToken,
  pollTelegramAuth,
  createTelegramSession,
  registerSession,
  getUserSessions,
  deleteUserSession,
  refreshTelegramUsername,
  deleteAccount,
} from "../controllers/authController";
import { sendMessage, getMessages } from "../controllers/contactController";
import { updateProfileValidation } from "../middleware/validators";
import { authenticate } from "../middleware/auth";
import {
  getUserChannels,
  addChannel,
  removeChannel,
  syncChannel,
  getSyncStatus,
  _syncInBackground,
} from "../controllers/channelsController";
import {
  getSongById,
  getSongs,
  getSongsByIds,
} from "../controllers/songsController";
import {
  getFavorites,
  toggleFavorite,
} from "../controllers/favoritesController";
import {
  getPlaylists,
  createPlaylist,
  deletePlaylist,
  getPlaylistSongs,
  addSongToPlaylist,
  removeSongFromPlaylist,
  reorderPlaylist,
  updatePlaylist,
} from "../controllers/playlistsController";
import {
  streamSong,
  streamByToken,
  checkDiskCache,
  issueStreamToken,
  getCacheStats,
} from "../controllers/streamController";
import { checkServerCache } from "../controllers/downloadsController";
import { getProxy, setProxy, testProxy } from "../controllers/proxyController";
import { adminAuth } from "../middleware/adminAuth";
import {
  listDefaultChannels,
  applyDefaultChannelsToAllUsers,
} from "../controllers/defaultChannelsController";
import {
  startForwarder,
  getForwarderStatus,
  cancelForwarder,
  listForwarderJobs,
} from "../controllers/forwarderController";
import mongoose from "mongoose";
import {
  createSubscriptionOrder,
  getOrderStatus,
  getPlans,
  getSubscriptionStatus,
  subscriptionCallback,
} from "../controllers/subscriptionController";
import {
  adminBroadcast,
  deleteBotSong,
  disconnectBot,
  generateCode,
  getBotSongs,
  getBotStatus,
  refreshBotSongThumbnails,
} from "../controllers/botController";
import {
  getMostPlayed,
  getRecentlyPlayed,
  recordPlay,
} from "../controllers/playHistoryController";
import { requirePremium } from "../middleware/requirePremium";

const router = Router();

// ── Auth ────────────────────────────────────────────────────────
router.post("/auth/refresh", refreshToken);
router.get("/auth/me", authenticate, getMe);
router.post("/auth/telegram", telegramAuth);
router.get("/auth/telegram/poll/:sessionId", pollTelegramAuth);
router.post("/auth/telegram/session", createTelegramSession);

router.put(
  "/auth/profile",
  authenticate,
  updateProfileValidation,
  updateProfile,
);
router.post("/auth/logout", authenticate, logout);
router.post("/auth/session/register", authenticate, registerSession);
router.get("/auth/sessions", authenticate, getUserSessions);
router.delete("/auth/sessions/:id", authenticate, deleteUserSession);
router.delete("/auth/account", authenticate, deleteAccount);
router.get(
  "/auth/telegram/refresh-username",
  authenticate,
  refreshTelegramUsername,
);

// ── Admin: Default Channels ─────────────────────────────────────
router.get("/admin/default-channels", adminAuth, listDefaultChannels);
router.post(
  "/admin/default-channels/apply-all",
  adminAuth,
  applyDefaultChannelsToAllUsers,
);

// ── Admin: Music Forwarder ──────────────────────────────────────
router.post("/admin/forwarder/start", adminAuth, startForwarder);
router.get("/admin/forwarder/jobs", adminAuth, listForwarderJobs);
router.get("/admin/forwarder/status/:jobId", adminAuth, getForwarderStatus);
router.post("/admin/forwarder/cancel/:jobId", adminAuth, cancelForwarder);

// ── Admin: Messages ──────────────────────────────────────────────
router.get("/admin/messages", adminAuth, getMessages);

// ── Subscription ────────────────────────────────────────────────
router.get("/subscription/plans", getPlans);
router.post("/subscription/order", authenticate, createSubscriptionOrder);
router.get("/subscription/order/:orderId/status", authenticate, getOrderStatus);
router.get("/subscription/callback", subscriptionCallback);
router.get("/subscription/status", authenticate, getSubscriptionStatus);

// ── Channels ────────────────────────────────────────────────────
router.get("/channels", authenticate, getUserChannels);
router.post("/channels", authenticate, requirePremium, addChannel);
router.delete("/channels/:username", authenticate, removeChannel);
router.post("/channels/:username/sync", authenticate, syncChannel);
router.get("/channels/:username/sync-status", authenticate, getSyncStatus);

// ── Admin: Sync Channel ─────────────────────────────────────────
router.post(
  "/admin/channels/:username/sync",
  adminAuth,
  async (req, res, next) => {
    try {
      const { username } = req.params;
      const db = mongoose.connection.db;

      const channel = await db.collection("channels").findOne({
        channelUsername: username,
      });

      if (channel?.status === "syncing") {
        return res.json({ success: true, msg: "Already syncing" });
      }

      await db
        .collection("channels")
        .updateOne(
          { channelUsername: username },
          { $set: { status: "syncing" } },
        );

      res.json({ success: true, msg: "Sync started" });

      const userChannel = await db.collection("user_channels").findOne({
        channelUsername: username,
      });
      const userId = userChannel?.userId ?? "";

      _syncInBackground(username, userId, db).catch(console.error);
    } catch (error) {
      next(error);
    }
  },
);

// ── Songs ───────────────────────────────────────────────────────
router.get("/songs", authenticate, getSongs);
router.get("/songs/by-ids", authenticate, getSongsByIds);
router.get("/songs/:id", authenticate, getSongById);

// ── Favorites ───────────────────────────────────────────────────
router.get("/favorites", authenticate, getFavorites);
router.post("/favorites/toggle", authenticate, toggleFavorite);

// ── Playlists ───────────────────────────────────────────────────
router.get("/playlists", authenticate, getPlaylists);
router.post("/playlists", authenticate, requirePremium, createPlaylist);
router.put("/playlists/:id", authenticate, updatePlaylist);
router.delete("/playlists/:id", authenticate, deletePlaylist);
router.get("/playlists/:id/songs", authenticate, getPlaylistSongs);
router.post(
  "/playlists/:id/songs",
  authenticate,
  requirePremium,
  addSongToPlaylist,
);
router.delete(
  "/playlists/:id/songs/:songId",
  authenticate,
  removeSongFromPlaylist,
);
router.post("/playlists/:id/reorder", authenticate, reorderPlaylist);

// ── Stream ──────────────────────────────────────────────────────
router.get("/stream/check/:fileId", authenticate, checkDiskCache);
router.get("/stream/token/:songId", authenticate, issueStreamToken);
router.get("/stream/admin/stats", authenticate, getCacheStats);
router.post("/stream", authenticate, requirePremium, streamSong);
router.get("/stream/:token", streamByToken);

// ── play-history ──────────────────────────────────────────────────────
router.post("/play-history", authenticate, recordPlay);
router.get("/play-history/most-played", authenticate, getMostPlayed);
router.get("/play-history/recent", authenticate, getRecentlyPlayed);

// ── Contact ─────────────────────────────────────────────────────
router.post("/contact", authenticate, sendMessage);

// ── Downloads ───────────────────────────────────────────────────
router.get("/downloads/check/:fileId", authenticate, checkServerCache);

// ── Proxy ───────────────────────────────────────────────────────
router.get("/proxy", authenticate, getProxy);
router.post("/proxy", authenticate, setProxy);
router.post("/proxy/test", authenticate, testProxy);

// Bot
router.post("/bot/connect/generate", authenticate, generateCode);
router.get("/bot/status", authenticate, getBotStatus);
router.delete("/bot/disconnect", authenticate, disconnectBot);
router.get("/bot/songs", authenticate, getBotSongs);
router.delete("/bot/songs/:id", authenticate, deleteBotSong);
router.post("/admin/bot/broadcast", adminAuth, adminBroadcast);
router.get(
  "/bot/songs/refresh-thumbnails",
  authenticate,
  refreshBotSongThumbnails,
);

export default router;
