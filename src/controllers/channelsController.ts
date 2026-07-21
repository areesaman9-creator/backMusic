import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import telegramService from "../services/telegram";
import { buildSearchFields } from "../utils/search";

// ── GET /api/channels ──────────────────────────────────────────
export const getUserChannels = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const db = mongoose.connection.db;

    const result = await db
      .collection("user_channels")
      .aggregate([
        { $match: { userId } },
        { $sort: { addedAt: -1 } },
        {
          $lookup: {
            from: "channels",
            localField: "channelUsername",
            foreignField: "channelUsername",
            as: "channel",
          },
        },
        {
          $replaceRoot: {
            newRoot: {
              $mergeObjects: [
                { $arrayElemAt: ["$channel", 0] },
                {
                  addedAt: "$addedAt",
                  isDefault: "$isDefault",
                  channelDisplayName: "$channelDisplayName",
                },
              ],
            },
          },
        },
      ])
      .toArray();

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/channels ─────────────────────────────────────────
export const addChannel = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const { channelUsername, channelName } = req.body;
    if (!channelUsername || !channelName) {
      return res.status(400).json({
        success: false,
        msg: "channelUsername and channelName required",
      });
    }

    const username = channelUsername.replace("@", "");
    const db = mongoose.connection.db;

    const alreadyAdded = await db.collection("user_channels").findOne({
      userId,
      channelUsername: username,
    });
    if (alreadyAdded) {
      return res
        .status(400)
        .json({ success: false, msg: "Channel already added" });
    }

    let channel = await db
      .collection("channels")
      .findOne({ channelUsername: username });
    let needsSync = false;

    if (!channel) {
      const photoUrl = await telegramService.getChannelPhoto(username, userId);
      const result = await db.collection("channels").insertOne({
        channelUsername: username,
        channelName: channelName,
        photoUrl,
        songsCount: 0,
        status: "pending",
        lastSync: null,
      });
      channel = {
        _id: result.insertedId,
        channelUsername: username,
        channelName,
        status: "pending",
        songsCount: 0,
      };
      needsSync = true;
    }

    await db.collection("user_channels").insertOne({
      userId,
      channelUsername: username,
      channelDisplayName: channelName,
      addedAt: new Date(),
      isDefault: false,
    });

    res
      .status(201)
      .json({ success: true, msg: "Channel added.", data: channel });

    if (needsSync) {
      _syncInBackground(username, userId, db).catch(console.error);
    }
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/channels/:id ───────────────────────────────────
export const removeChannel = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const username = req.params.username;
    const db = mongoose.connection.db;

    const result = await db.collection("user_channels").deleteOne({
      userId,
      channelUsername: username,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, msg: "Channel not found" });
    }

    const isDefault = await db
      .collection("default_channels")
      .findOne({ channelUsername: username });

    if (isDefault) {
      await db
        .collection("user_deleted_default_channels")
        .updateOne(
          { userId, channelUsername: username },
          {
            $set: { userId, channelUsername: username, deletedAt: new Date() },
          },
          { upsert: true },
        );
    }

    res.json({ success: true, msg: "Channel removed" });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/channels/:id/sync ────────────────────────────────
export const syncChannel = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const { username } = req.params;
    const db = mongoose.connection.db;

    const userChannel = await db.collection("user_channels").findOne({
      userId,
      channelUsername: username,
    });
    if (!userChannel) {
      return res.status(404).json({ success: false, msg: "Channel not found" });
    }

    const channel = await db
      .collection("channels")
      .findOne({ channelUsername: username });
    if (channel?.status === "syncing") {
      return res.json({
        success: true,
        syncing: true,
        msg: "Sync already in progress",
      });
    }

    const SYNC_COOLDOWN_MS = 10 * 60 * 1000; 
    if (
      channel?.status === "active" &&
      channel.lastSync &&
      Date.now() - new Date(channel.lastSync).getTime() < SYNC_COOLDOWN_MS
    ) {
      return res.json({
        success: true,
        syncing: false,
        msg: "Channel is already up to date",
        songsCount: channel.songsCount,
      });
    }

    await db
      .collection("channels")
      .updateOne(
        { channelUsername: username },
        { $set: { status: "syncing" } },
      );

    res.json({ success: true, syncing: true, msg: "Sync started." });

    _syncInBackground(username, userId, db).catch((err) => {
      console.error(`Background sync failed for ${username}:`, err);
      db.collection("channels")
        .updateOne({ channelUsername: username }, { $set: { status: "error" } })
        .catch(() => {});
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/channels/:id/sync-status ─────────────────────────
export const getSyncStatus = async (req, res, next) => {
  try {
    const userId = (req as any).user.id.toString();
    const { username } = req.params;
    const db = mongoose.connection.db;

    const userChannel = await db.collection("user_channels").findOne({
      userId,
      channelUsername: username,
    });
    if (!userChannel) {
      return res.status(404).json({ success: false, msg: "Channel not found" });
    }

    const channel = await db.collection("channels").findOne(
      { channelUsername: username },
      {
        projection: {
          status: 1,
          songsCount: 1,
          totalEstimate: 1,
          lastSync: 1,
        },
      },
    );

    res.json({
      success: true,
      status: channel?.status ?? "pending",
      songsCount: channel?.songsCount ?? 0,
      totalEstimate: channel?.totalEstimate ?? 0,
      lastSync: channel?.lastSync ?? null,
    });
  } catch (error) {
    next(error);
  }
};

// ── Background sync ────────────────────────────────────────────
export async function _syncInBackground(
  username: string,
  userId: any,
  db: any,
): Promise<void> {
  const latestSong = await db
    .collection("songs")
    .find({ channelUsername: username })
    .sort({ messageId: -1 })
    .limit(1)
    .project({ messageId: 1 })
    .toArray();

  const lastMessageId = latestSong[0]?.messageId ?? 0;

  await db
    .collection("channels")
    .updateOne(
      { channelUsername: username },
      { $set: { status: "syncing", totalEstimate: 0 } },
    );

  const result = await telegramService.getChannelAudioFiles(
    username,
    userId,
    lastMessageId,
    async (batch, totalEstimate) => {
      const bulkOps = batch.map((file) => {
        const { searchWords, searchPrefixes } = buildSearchFields(
          file.title,
          file.artist,
        );
        return {
          updateOne: {
            filter: { channelUsername: username, messageId: file.messageId },
            update: {
              $set: {
                channelUsername: username,
                title: file.title,
                artist: file.artist,
                duration: file.duration,
                fileId: file.fileId,
                fileSize: file.fileSize,
                mimeType: file.mimeType,
                messageId: file.messageId,
                messageDate: new Date(file.messageDate * 1000),
                thumbnail: file.thumbnail || null,
                searchWords,
                searchPrefixes,
              },
            },
            upsert: true,
          },
        };
      });
      await db.collection("songs").bulkWrite(bulkOps, { ordered: false });

      const syncedCount = await db
        .collection("songs")
        .countDocuments({ channelUsername: username });

      await db.collection("channels").updateOne(
        { channelUsername: username },
        {
          $set: {
            songsCount: syncedCount,
            totalEstimate: totalEstimate || syncedCount,
          },
        },
      );
    },
  );

  if (!result.success || !result.files) {
    await db
      .collection("channels")
      .updateOne({ channelUsername: username }, { $set: { status: "error" } });
    return;
  }

  let photoUrl: string | null = null;
  let realChannelName: string | null = null;
  try {
    photoUrl = await telegramService.getChannelPhoto(username, userId);
    realChannelName = await telegramService.getChannelName(username, userId);
  } catch (_) {}

  await db.collection("channels").updateOne(
    { channelUsername: username },
    {
      $set: {
        status: "active",
        lastSync: new Date(),
        ...(photoUrl ? { photoUrl } : {}),
        ...(realChannelName ? { channelName: realChannelName } : {}),
      },
    },
  );
}

// ── Reusable helper ────────────────────────────────────────────
export async function addChannelForUser(
  userId: string,
  channelUsername: string,
  channelName: string,
  db: any,
): Promise<{ added: boolean; reason?: string }> {
  try {
    const username = channelUsername.replace("@", "");

    const exists = await db.collection("user_channels").findOne({
      userId,
      channelUsername: username,
    });
    if (exists) return { added: false, reason: "already exists" };

    let channel = await db
      .collection("channels")
      .findOne({ channelUsername: username });
    let needsSync = false;

    if (!channel) {
      let photoUrl: string | null = null;
      try {
        photoUrl = await telegramService.getChannelPhoto(username, userId);
      } catch (_) {}

      await db.collection("channels").insertOne({
        channelUsername: username,
        channelName,
        photoUrl,
        songsCount: 0,
        status: "pending",
        lastSync: null,
      });
      needsSync = true;
    }

    await db.collection("user_channels").insertOne({
      userId,
      channelUsername: username,
      channelDisplayName: channelName,
      addedAt: new Date(),
      isDefault: true,
    });

    if (needsSync) {
      _syncInBackground(username, userId, db).catch(console.error);
    }

    return { added: true };
  } catch (err) {
    console.error("addChannelForUser failed:", err);
    return { added: false, reason: "error" };
  }
}
