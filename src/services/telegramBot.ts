import TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import mongoose from "mongoose";
import crypto from "crypto";
import axios from "axios";
import User from "../models/User";

function escapeMarkdown(text?: string | null): string {
  if (!text) return "";
  return text.replace(/([_*`\[])/g, "\\$1");
}

const BOT_AUTH_SECRET = process.env.BOT_AUTH_SECRET!;
const API_BASE = process.env.PUBLIC_API_URL!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const pendingConnections = new Map<
  string,
  { userId: string; expiresAt: Date }
>();

// ── Update de-duplication ────────────────────────────────────────
const _recentlyHandled = new Set<string>();
function isDuplicateUpdate(key: string): boolean {
  if (_recentlyHandled.has(key)) return true;
  _recentlyHandled.add(key);
  setTimeout(() => _recentlyHandled.delete(key), 60_000);
  return false;
}

export function generateConnectionCode(userId: string): string {
  for (const [code, data] of pendingConnections.entries()) {
    if (data.userId === userId) pendingConnections.delete(code);
  }
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  pendingConnections.set(code, {
    userId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return code;
}

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (isDuplicateUpdate(`start_${chatId}_${msg.message_id}`)) return;
  const telegramId = msg.from.id.toString();
  const telegramUsername = msg.from.username || "";
  const name = [msg.from.first_name, msg.from.last_name]
    .filter(Boolean)
    .join(" ");
  const payload = match?.[1];
  const db = mongoose.connection.db;

  try {
    const authToken = `${BOT_AUTH_SECRET}_${telegramId}`;
    const res = await axios.post(`${API_BASE}/auth/telegram`, {
      telegramId,
      telegramUsername,
      name,
      authToken,
    });
    const { isNew, user } = res.data.data;

    if (payload && payload.startsWith("auth_")) {
      const sessionId = payload.replace("auth_", "");
      await db.collection("telegram_auth_sessions").updateOne(
        { sessionId },
        {
          $set: {
            status: "confirmed",
            telegramId,
            userId: user.id,
            isNew,
            confirmedAt: new Date(),
          },
        },
        { upsert: true },
      );
    } else {
      await db.collection("telegram_auth_sessions").updateOne(
        { telegramId },
        {
          $set: {
            telegramId,
            status: "confirmed",
            userId: user.id,
            isNew,
            confirmedAt: new Date(),
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          },
        },
        { upsert: true },
      );
    }

    await bot.sendMessage(
      chatId,
      isNew
        ? `🎵 *Welcome to Tel Player!*\n\nYour account has been created successfully.`
        : `✅ *Authentication Successful*\n\nWelcome back to Tel Player.`,
      { parse_mode: "Markdown" },
    );
    await sendMainMenu(chatId);
  } catch (err) {
    console.error("Telegram auth failed:", err.response?.data || err.message);
    await bot.sendMessage(
      chatId,
      `❌ *Authentication Failed*\n\nWe were unable to complete your authentication.\nPlease try again in a few moments.`,
      { parse_mode: "Markdown" },
    );
  }
});

bot.onText(/^\/menu$/, async (msg) => {
  await sendMainMenu(msg.chat.id);
});

bot.onText(/^[A-F0-9]{6}$/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const telegramUsername = msg.from!.username || "";
  const code = msg.text!.trim().toUpperCase();
  const db = mongoose.connection.db;

  const pending = pendingConnections.get(code);
  if (!pending || new Date() > pending.expiresAt) {
    pendingConnections.delete(code);
    return bot.sendMessage(
      chatId,
      "❌ Invalid or expired code. Please generate a new one in the app.",
    );
  }

  await db.collection("bot_connections").updateOne(
    { userId: pending.userId },
    {
      $set: {
        userId: pending.userId,
        telegramId,
        telegramUsername,
        connectedAt: new Date(),
        isActive: true,
      },
    },
    { upsert: true },
  );

  pendingConnections.delete(code);

  bot.sendMessage(
    chatId,
    `✅ *Connected successfully!*\n\n` +
      `You can now send me audio files and they'll appear in your Tel Player app. 🎶\n\n` +
      `Use /mystats to see your account info.`,
    { parse_mode: "Markdown" },
  );
});

bot.onText(/\/disconnect/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const db = mongoose.connection.db;

  const existing = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });

  if (!existing) {
    return bot.sendMessage(chatId, "You are not connected to any account.");
  }

  await db
    .collection("bot_connections")
    .updateOne({ telegramId }, { $set: { isActive: false } });

  bot.sendMessage(
    chatId,
    "🔌 Disconnected. Send /start to link a new account.",
  );
});

bot.onText(/\/mystats/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const db = mongoose.connection.db;

  const connection = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });

  if (!connection) {
    return bot.sendMessage(
      chatId,
      "❌ You're not connected to an account. Send /start to get started.",
    );
  }

  const [botSongsCount, user] = await Promise.all([
    db.collection("bot_songs").countDocuments({ userId: connection.userId }),
    db.collection("users").findOne(
      { _id: new mongoose.Types.ObjectId(connection.userId) },
      {
        projection: {
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
          name: 1,
        },
      },
    ),
  ]);

  const isPremium =
    user?.subscriptionExpiresAt &&
    new Date(user.subscriptionExpiresAt) > new Date();

  const expiryDate = isPremium
    ? new Date(user.subscriptionExpiresAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  bot.sendMessage(
    chatId,
    `📊 *Your Account Stats*\n\n` +
      `👤 Name: ${user?.name || "—"}\n` +
      `🎵 Songs sent via bot: ${botSongsCount}\n` +
      `💎 Subscription: ${isPremium ? "Active ✅" : "None ❌"}\n` +
      (isPremium ? `📅 Expires: ${expiryDate}\n` : "") +
      `\nTo manage your subscription, open the Tel Player app.`,
    { parse_mode: "Markdown" },
  );
});

bot.onText(/^(\/updateusername|update username)$/i, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const telegramUsername = msg.from!.username || "";
  await handleUpdateUsername(chatId, telegramId, telegramUsername);
});

async function _handleAudioMessage(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id.toString();
  const db = mongoose.connection.db;

  const connection = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });

  if (!connection) {
    return bot.sendMessage(
      chatId,
      "❌ Please connect your account first.\nSend /start to get started.",
    );
  }

  const audio = msg.audio || msg.document;
  if (!audio) return;

  const originalFileId = audio.file_id;

  const exists = await db.collection("bot_songs").findOne({
    userId: connection.userId,
    originalFileId,
  });
  if (exists) {
    return bot.sendMessage(chatId, `⚠️ This track has already been received.`);
  }

  // Forward به کانال storage
  const storageChannel = process.env.BOT_STORAGE_CHANNEL!;
  let storageMessageId: number;
  let storageChannelUsername: string;

  try {
    const forwarded = await bot.forwardMessage(
      storageChannel,
      chatId,
      msg.message_id,
    );
    storageMessageId = forwarded.message_id;
    storageChannelUsername = storageChannel.replace("@", "");
  } catch (err: any) {
    console.error("Failed to forward to storage channel:", err.message);
    return bot.sendMessage(
      chatId,
      "❌ Failed to process your file. Please try again.",
    );
  }

  const title =
    msg.audio?.title ||
    (audio as any).file_name?.replace(/\.[^.]+$/, "") ||
    "Unknown";
  const artist = msg.audio?.performer || "Unknown";
  const duration = msg.audio?.duration || 0;
  const fileSize = audio.file_size || 0;
  const mimeType =
    msg.audio?.mime_type || (audio as any).mime_type || "audio/mpeg";

  // دانلود thumbnail — اگه audio.thumb داشت
  let thumbnail: string | null = null;
  const thumb = (msg.audio as any)?.thumb || (msg.document as any)?.thumb;

  if (thumb?.file_id) {
    try {
      const fileLink = await bot.getFileLink(thumb.file_id);
      const https = require("https");
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        https
          .get(fileLink, (res: any) => {
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", resolve);
            res.on("error", reject);
          })
          .on("error", reject);
      });

      const buffer = Buffer.concat(chunks);
      thumbnail = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    } catch (e: any) {
      console.warn("Failed to download thumbnail:", e.message);
    }
  }

  await db.collection("bot_songs").insertOne({
    userId: connection.userId,
    telegramId,
    originalFileId,
    fileId: originalFileId,
    channelUsername: storageChannelUsername,
    messageId: storageMessageId,
    title,
    artist,
    duration,
    fileSize,
    mimeType,
    thumbnail,
    receivedAt: new Date(),
  });

  const durationStr =
    duration > 0
      ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`
      : "—";

  bot.sendMessage(
    chatId,
    `✅ *${title}* received!\n` +
      `🎤 ${artist !== "Unknown" ? artist : "Unknown artist"}  •  ⏱ ${durationStr}\n\n` +
      `Open Tel Player to download and play it. 🎵`,
    { parse_mode: "Markdown" },
  );
}

bot.on("audio", _handleAudioMessage);
bot.on("document", async (msg) => {
  if (msg.document?.mime_type?.startsWith("audio/")) {
    await _handleAudioMessage(msg);
  }
});

bot.on("polling_error", (err) => {
  console.error("❌ Bot polling error:", err.message);
});

// ── Edit-in-place helper ─────────────────────────────────────────
async function sendOrEdit(
  chatId: number,
  messageId: number | undefined,
  text: string,
  options: TelegramBot.SendMessageOptions = {},
) {
  if (messageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: options.parse_mode,
        reply_markup: options.reply_markup as any,
      });
      return;
    } catch (err: any) {
      const desc = err?.response?.body?.description || err.message || "";
      if (desc.includes("message is not modified")) return;
      console.error("editMessageText failed, sending new message:", desc);
    }
  }
  await bot.sendMessage(chatId, text, options);
}
// ── Inline Menu ─────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📊 Account", callback_data: "menu_account" }],
      [{ text: "👤 Update Username", callback_data: "menu_update_username" }],
      [{ text: "📤 Send Music", callback_data: "menu_send_music" }],
      [{ text: "📱 Sessions", callback_data: "menu_sessions" }],
    ],
  };
}

async function sendMainMenu(chatId: number, messageId?: number) {
  await sendOrEdit(
    chatId,
    messageId,
    `🎧 *Tel Player*\n\nWhat would you like to do?`,
    { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() },
  );
}

const backToMenuKeyboard = {
  inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "back_menu" }]],
};

async function handleUpdateUsername(
  chatId: number,
  telegramId: string,
  telegramUsername: string,
  messageId?: number,
) {
  try {
    const user = await User.findOne({ telegramId });
    if (!user) {
      return sendOrEdit(
        chatId,
        messageId,
        "❌ *Account Not Found*\n\nPlease log in to Tel Player first, then try again.",
        { parse_mode: "Markdown", reply_markup: backToMenuKeyboard },
      );
    }

    if (!telegramUsername) {
      return sendOrEdit(
        chatId,
        messageId,
        "⚠️ *No Telegram Username Set*\n\nGo to Telegram → Settings → Username, set one, then try again.",
        { parse_mode: "Markdown", reply_markup: backToMenuKeyboard },
      );
    }

    user.telegramUsername = telegramUsername;
    await user.save();

    await sendOrEdit(
      chatId,
      messageId,
      `✅ *Username Updated*\n\nYour username is now set to @${escapeMarkdown(telegramUsername)}.\nYou can return to the app now.`,
      { parse_mode: "Markdown", reply_markup: backToMenuKeyboard },
    );
  } catch (err) {
    await sendOrEdit(
      chatId,
      messageId,
      "❌ Something went wrong. Please try again.",
    );
  }
}

async function sendAccountInfo(
  chatId: number,
  telegramId: string,
  db: any,
  messageId?: number,
) {
  try {
    const user = await User.findOne({ telegramId });
    if (!user) {
      return sendOrEdit(
        chatId,
        messageId,
        "❌ *Account Not Found*\n\nPlease log in to Tel Player first.",
        { parse_mode: "Markdown", reply_markup: backToMenuKeyboard },
      );
    }
    const userId = user._id.toString();

    const [channelCount, playlistCount, userChannels, botSongsCount] =
      await Promise.all([
        db.collection("user_channels").countDocuments({ userId }),
        db.collection("user_playlists").countDocuments({ userId }),
        db
          .collection("user_channels")
          .find({ userId })
          .project({ channelUsername: 1 })
          .toArray(),
        db.collection("bot_songs").countDocuments({ userId }),
      ]);

    const channelUsernames = userChannels.map((c: any) => c.channelUsername);
    const channelSongsAgg = channelUsernames.length
      ? await db
          .collection("channels")
          .aggregate([
            { $match: { channelUsername: { $in: channelUsernames } } },
            { $group: { _id: null, total: { $sum: "$songsCount" } } },
          ])
          .toArray()
      : [];

    const songCount = (channelSongsAgg[0]?.total ?? 0) + botSongsCount;

    const isPremium =
      !!user.subscriptionExpiresAt &&
      new Date(user.subscriptionExpiresAt) > new Date();
    const expiryStr = isPremium
      ? new Date(user.subscriptionExpiresAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;

    const safeName = escapeMarkdown(user.name) || "—";
    const safeUsername = user.telegramUsername
      ? "@" + escapeMarkdown(user.telegramUsername)
      : "—";

    const expiryDate = isPremium
      ? new Date(user.subscriptionExpiresAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;
    const text =
      `📊 *Account Overview*\n\n` +
      `👤 *Name:* ${safeName}\n` +
      `🔗 *Username:* ${safeUsername}\n\n` +
      // `🎵 *Songs:* ${songCount.toLocaleString()}\n` +
      `📁 *Channels:* ${channelCount.toLocaleString()}\n` +
      `📃 *Playlists:* ${playlistCount.toLocaleString()}\n\n` +
      `💎 Subscription: ${isPremium ? "Active ✅" : "None ❌"}\n` +
      (isPremium ? `📅 Expires: ${expiryDate}\n` : "") +
      `\nTo manage your subscription, open the Tel Player app.`;

    await sendOrEdit(chatId, messageId, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📁 All Channels", callback_data: "all_channels" },
            { text: "📃 All Playlists", callback_data: "all_playlists" },
          ],
          [{ text: "⬅️ Back to Menu", callback_data: "back_menu" }],
        ],
      },
    });
  } catch (err) {
    console.error("sendAccountInfo error:", err);
    await sendOrEdit(
      chatId,
      messageId,
      "❌ Could not load your account info. Please try again.",
      { reply_markup: backToMenuKeyboard },
    );
  }
}

async function sendAllChannels(
  chatId: number,
  telegramId: string,
  db: any,
  messageId?: number,
) {
  const user = await User.findOne({ telegramId });
  if (!user) {
    return sendOrEdit(chatId, messageId, "❌ Account not found.", {
      reply_markup: backToMenuKeyboard,
    });
  }
  const userId = user._id.toString();

  const userChannels = await db
    .collection("user_channels")
    .find({ userId })
    .sort({ addedAt: -1 })
    .toArray();

  if (userChannels.length === 0) {
    return sendOrEdit(
      chatId,
      messageId,
      "📁 You haven't added any channels yet.",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back", callback_data: "menu_account" }],
          ],
        },
      },
    );
  }

  const usernames = userChannels.map((c: any) => c.channelUsername);
  const channelDocs = await db
    .collection("channels")
    .find({ channelUsername: { $in: usernames } })
    .project({ channelUsername: 1, songsCount: 1 })
    .toArray();
  const songCountMap = new Map(
    channelDocs.map((c: any) => [c.channelUsername, c.songsCount || 0]),
  );

  const MAX = 30;
  const lines = userChannels.slice(0, MAX).map((c: any, i: number) => {
    const name = c.channelDisplayName || c.channelUsername;
    const count = songCountMap.get(c.channelUsername) ?? 0;
    return `${i + 1}. *${name}* (@${c.channelUsername}) — ${count} songs`;
  });

  let text = `📁 *Your Channels (${userChannels.length})*\n\n${lines.join("\n")}`;
  if (userChannels.length > MAX) {
    text += `\n\n_…and ${userChannels.length - MAX} more. Open the app to see all._`;
  }

  await sendOrEdit(chatId, messageId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_account" }]],
    },
  });
}

async function sendAllPlaylists(
  chatId: number,
  telegramId: string,
  db: any,
  messageId?: number,
) {
  const user = await User.findOne({ telegramId });
  if (!user) {
    return sendOrEdit(chatId, messageId, "❌ Account not found.", {
      reply_markup: backToMenuKeyboard,
    });
  }
  const userId = user._id.toString();

  const playlists = await db
    .collection("user_playlists")
    .find({ userId })
    .sort({ updatedAt: -1 })
    .toArray();

  if (playlists.length === 0) {
    return sendOrEdit(
      chatId,
      messageId,
      "📃 You haven't created any playlists yet.",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back", callback_data: "menu_account" }],
          ],
        },
      },
    );
  }

  const MAX = 30;
  const lines = playlists.slice(0, MAX).map((p: any, i: number) => {
    const count = (p.songIds || []).length;
    return `${i + 1}. *${p.name}* — ${count} songs`;
  });

  let text = `📃 *Your Playlists (${playlists.length})*\n\n${lines.join("\n")}`;
  if (playlists.length > MAX) {
    text += `\n\n_…and ${playlists.length - MAX} more. Open the app to see all._`;
  }

  await sendOrEdit(chatId, messageId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_account" }]],
    },
  });
}

async function sendMusicGuide(
  chatId: number,
  telegramId: string,
  db: any,
  messageId?: number,
) {
  const connection = await db
    .collection("bot_connections")
    .findOne({ telegramId, isActive: true });
  const connected = !!connection;

  const text = connected
    ? `📤 *Send Music*\n\n✅ This Telegram account is connected to Tel Player.\n\nJust send any audio file to this chat — it will be added to your *Bot Inbox* automatically. 🎶`
    : `📤 *Send Music*\n\n⚠️ This Telegram account isn't connected yet.\n\nOpen Tel Player → *Bot Inbox* → *Get Connection Code*, then send that 6-character code here.\nOnce connected, any audio file you send will be added to your library automatically.`;

  await sendOrEdit(chatId, messageId, text, {
    parse_mode: "Markdown",
    reply_markup: backToMenuKeyboard,
  });
}

async function sendSessionsList(
  chatId: number,
  telegramId: string,
  db: any,
  messageId?: number,
) {
  const user = await User.findOne({ telegramId });
  if (!user) {
    return sendOrEdit(chatId, messageId, "❌ Account not found.", {
      reply_markup: backToMenuKeyboard,
    });
  }
  const userId = user._id.toString();

  const sessions = await db
    .collection("user_sessions")
    .find({ userId, isActive: true })
    .sort({ lastActive: -1 })
    .toArray();

  if (sessions.length === 0) {
    return sendOrEdit(chatId, messageId, "📱 No active sessions found.", {
      reply_markup: backToMenuKeyboard,
    });
  }

  const shown = sessions.slice(0, 20);
  const lines = shown.map((s: any, i: number) => {
    const last = s.lastActive
      ? new Date(s.lastActive).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })
      : "—";
    return `${i + 1}. *${s.deviceName || "Unknown Device"}*\n    ${s.platform || "—"} · last active ${last}`;
  });

  const text = `📱 *Active Sessions (${sessions.length})*\n\n${lines.join(
    "\n\n",
  )}\n\nTap below to sign a session out.`;

  const buttons = shown.map((s: any, i: number) => [
    { text: `🚪 Sign out #${i + 1}`, callback_data: `session_del_${s._id}` },
  ]);
  buttons.push([{ text: "⬅️ Back to Menu", callback_data: "back_menu" }]);

  await sendOrEdit(chatId, messageId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function removeSession(
  chatId: number,
  telegramId: string,
  sessionId: string,
  db: any,
  messageId?: number,
) {
  const user = await User.findOne({ telegramId });
  if (!user) {
    return sendOrEdit(chatId, messageId, "❌ Account not found.", {
      reply_markup: backToMenuKeyboard,
    });
  }
  const userId = user._id.toString();

  await db
    .collection("user_sessions")
    .updateOne({ _id: sessionId, userId }, { $set: { isActive: false } });

  await sendSessionsList(chatId, telegramId, db, messageId);
}

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId) return;

  const telegramId = query.from.id.toString();
  const telegramUsername = query.from.username || "";
  const data = query.data || "";
  const db = mongoose.connection.db;

  try {
    if (data === "menu_account") {
      await sendAccountInfo(chatId, telegramId, db, messageId);
    } else if (data === "menu_update_username") {
      await handleUpdateUsername(
        chatId,
        telegramId,
        telegramUsername,
        messageId,
      );
    } else if (data === "menu_send_music") {
      await sendMusicGuide(chatId, telegramId, db, messageId);
    } else if (data === "menu_sessions") {
      await sendSessionsList(chatId, telegramId, db, messageId);
    } else if (data === "all_channels") {
      await sendAllChannels(chatId, telegramId, db, messageId);
    } else if (data === "all_playlists") {
      await sendAllPlaylists(chatId, telegramId, db, messageId);
    } else if (data === "back_menu") {
      await sendMainMenu(chatId, messageId);
    } else if (data.startsWith("session_del_")) {
      const sessionId = data.replace("session_del_", "");
      await removeSession(chatId, telegramId, sessionId, db, messageId);
      await bot.answerCallbackQuery(query.id, {
        text: "Session signed out ✅",
      });
      return;
    }
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("callback_query error:", err);
    await bot
      .answerCallbackQuery(query.id, {
        text: "Something went wrong. Please try again.",
        show_alert: true,
      })
      .catch(() => {});
  }
});

export async function broadcastMessage(
  message: string,
  targetUserIds?: string[],
): Promise<{ sent: number; failed: number }> {
  const db = mongoose.connection.db;

  const filter: any = { isActive: true };
  if (targetUserIds?.length) filter.userId = { $in: targetUserIds };

  const connections = await db
    .collection("bot_connections")
    .find(filter)
    .toArray();

  let sent = 0,
    failed = 0;

  for (const conn of connections) {
    try {
      await bot.sendMessage(conn.telegramId, message, {
        parse_mode: "Markdown",
      });
      sent++;
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      failed++;
    }
  }

  return { sent, failed };
}

export default bot;
