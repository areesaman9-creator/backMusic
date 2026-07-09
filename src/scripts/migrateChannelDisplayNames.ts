/**
 * میگریشن: جدا کردن channelName واقعی از channelDisplayName
 *
 * وضعیت قبل از migration:
 *   channels.channelName        = نامی که یوزر موقع add کردن داد
 *   user_channels               = فیلد channelDisplayName ندارد
 *
 * وضعیت بعد از migration:
 *   channels.channelName        = نام واقعی کانال در تلگرام
 *   user_channels.channelDisplayName = نامی که یوزر داده بود (= channels.channelName قدیمی)
 *
 * اجرا:
 *   npx ts-node src/scripts/migrateChannelDisplayNames.ts
 *
 * گزینه‌ها:
 *   --dry-run     فقط گزارش بدهد، چیزی ننویسد
 *   --skip-fetch  نام واقعی تلگرام را نگیرد (فقط channelDisplayName را پُر کند)
 */

import mongoose from "mongoose";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

// ── CLI flags ──────────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_FETCH = process.argv.includes("--skip-fetch");

// ── Telegram client (برای گرفتن نام واقعی) ────────────────────
const API_ID = parseInt(process.env.TELEGRAM_API_ID as string, 10);
const API_HASH = process.env.TELEGRAM_API_HASH as string;
const SESSION_STRING = process.env.TELEGRAM_SESSION_STRING as string;

// نام واقعی کانال را از تلگرام بگیر
async function fetchRealChannelTitle(
  client: TelegramClient,
  username: string
): Promise<string | null> {
  try {
    const entity = await client.getEntity(username.replace("@", ""));
    return (entity as any).title ?? null;
  } catch (err: any) {
    console.warn(`  ⚠️  Could not fetch title for @${username}: ${err.message}`);
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────
async function migrate() {
  console.log("\n🔄 Channel Display Name Migration");
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`   Telegram fetch: ${SKIP_FETCH ? "SKIPPED" : "ENABLED"}\n`);

  // ── Connect MongoDB ────────────────────────────────────────
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`✅ MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}\n`);

  // ── Connect Telegram (optional) ───────────────────────────
  let telegramClient: TelegramClient | null = null;
  if (!SKIP_FETCH) {
    if (!API_ID || !API_HASH || !SESSION_STRING) {
      console.warn("⚠️  Telegram env vars missing — falling back to --skip-fetch mode\n");
    } else {
      try {
        const session = new StringSession(SESSION_STRING);
        telegramClient = new TelegramClient(session, API_ID, API_HASH, {
          connectionRetries: 3,
          useWSS: false,
        });
        await telegramClient.connect();
        console.log("✅ Telegram connected\n");
      } catch (err: any) {
        console.warn(`⚠️  Telegram connect failed: ${err.message}`);
        console.warn("   Falling back to --skip-fetch mode\n");
        telegramClient = null;
      }
    }
  }

  // ── Load all channels ──────────────────────────────────────
  const channels = await db.collection("channels").find({}).toArray();
  console.log(`📋 Found ${channels.length} channel(s) in channels collection\n`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const ch of channels) {
    const username: string = ch.channelUsername;
    const currentName: string = ch.channelName ?? "";

    console.log(`─── @${username}`);
    console.log(`    channelName (current): "${currentName}"`);

    // ── Step 1: نام واقعی را از تلگرام بگیر ──────────────────
    let realTitle: string | null = null;

    if (telegramClient) {
      console.log("    Fetching real title from Telegram...");
      realTitle = await fetchRealChannelTitle(telegramClient, username);

      // rate limit: کمی صبر کن
      await new Promise((r) => setTimeout(r, 400));
    }

    // اگه نتونستیم بگیریم، همون نام فعلی رو نگه می‌داریم
    const newChannelName = realTitle ?? currentName;
    const changed = realTitle !== null && realTitle !== currentName;

    console.log(`    Real title:            "${newChannelName}" ${changed ? "← CHANGED" : "(same)"}`);

    // ── Step 2: همه user_channels این کانال را پیدا کن ────────
    const userChannels = await db
      .collection("user_channels")
      .find({ channelUsername: username })
      .toArray();

    console.log(`    user_channels rows:    ${userChannels.length}`);

    let rowsUpdated = 0;
    for (const uc of userChannels) {
      // اگه channelDisplayName قبلاً set شده باشه، skip کن
      if (uc.channelDisplayName !== undefined && uc.channelDisplayName !== null) {
        console.log(`    [userId=${uc.userId}] channelDisplayName already set → skip`);
        continue;
      }

      // نام نمایشی = همون نامی که الان در channels.channelName هست
      const displayName = currentName;

      if (!DRY_RUN) {
        await db.collection("user_channels").updateOne(
          { _id: uc._id },
          { $set: { channelDisplayName: displayName } }
        );
      }
      console.log(`    [userId=${uc.userId}] channelDisplayName ← "${displayName}"${DRY_RUN ? " (dry)" : ""}`);
      rowsUpdated++;
    }

    // ── Step 3: channelName واقعی را در channels بنویس ────────
    if (changed) {
      if (!DRY_RUN) {
        await db.collection("channels").updateOne(
          { _id: ch._id },
          { $set: { channelName: newChannelName } }
        );
      }
      console.log(`    channels.channelName ← "${newChannelName}"${DRY_RUN ? " (dry)" : ""}`);
    }

    console.log(`    ✔  rows updated: ${rowsUpdated}\n`);
    processed++;
  }

  // ── Summary ────────────────────────────────────────────────
  console.log("═══════════════════════════════════════");
  console.log(`✅ Migration complete`);
  console.log(`   Channels processed : ${processed}`);
  console.log(`   Skipped            : ${skipped}`);
  console.log(`   Failed             : ${failed}`);
  if (DRY_RUN) {
    console.log("\n⚠️  DRY RUN — nothing was written to the database");
    console.log("   Run without --dry-run to apply changes");
  }
  console.log("═══════════════════════════════════════\n");

  // ── Cleanup ────────────────────────────────────────────────
  if (telegramClient) {
    try { await telegramClient.disconnect(); } catch (_) {}
  }
  await mongoose.disconnect();
  console.log("🔌 Disconnected\n");
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});