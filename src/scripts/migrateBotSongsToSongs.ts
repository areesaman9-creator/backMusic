/**
 * آهنگ‌های موجود در bot_songs رو به کالکشن songs هم منتقل می‌کنه.
 * اجرا:
 *   npx ts-node src/scripts/migrateBotSongsToSongs.ts
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { buildSearchFields } from "../utils/search";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`🔌 Connected: ${mongoose.connection.host}/${mongoose.connection.name}`);

  const botSongs = await db.collection("bot_songs").find({}).toArray();
  console.log(`📦 ${botSongs.length} bot_songs found`);

  let migrated = 0;
  const bulkOps: any[] = [];

  for (const bs of botSongs) {
    const { searchWords, searchPrefixes } = buildSearchFields(bs.title, bs.artist);

    bulkOps.push({
      updateOne: {
        filter: { channelUsername: bs.channelUsername, messageId: bs.messageId },
        update: {
          $set: {
            channelUsername: bs.channelUsername,
            title: bs.title,
            artist: bs.artist,
            duration: bs.duration,
            fileId: bs.fileId,
            fileSize: bs.fileSize,
            mimeType: bs.mimeType,
            messageId: bs.messageId,
            messageDate: bs.receivedAt || new Date(),
            thumbnail: null,
            searchWords,
            searchPrefixes,
          },
        },
        upsert: true,
      },
    });

    if (bulkOps.length >= 500) {
      await db.collection("songs").bulkWrite(bulkOps, { ordered: false });
      migrated += bulkOps.length;
      bulkOps.length = 0;
      console.log(`   …${migrated}/${botSongs.length}`);
    }
  }

  if (bulkOps.length > 0) {
    await db.collection("songs").bulkWrite(bulkOps, { ordered: false });
    migrated += bulkOps.length;
  }

  console.log(`✅ Migrated ${migrated} bot_songs → songs`);
  await mongoose.disconnect();
  console.log("🔌 Disconnected");
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});