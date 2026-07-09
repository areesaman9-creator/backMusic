/**
 * یک‌بار اجرا کن (و هر وقت منطق buildSearchFields عوض شد دوباره):
 *   npx ts-node src/scripts/backfillSearchIndex.ts
 *
 * searchWords/searchPrefixes رو برای همه‌ی آهنگ‌های موجود محاسبه می‌کنه
 * تا سرچ ایندکس‌محور روی دیتای قبلاً sync‌شده هم کار کنه.
 * Idempotent — هر بار اجرا کنی مقادیر تازه رو می‌نویسه.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { buildSearchFields } from "../utils/search";

dotenv.config({ path: ".env.local" });
const BATCH_SIZE = 500;

async function backfill() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set in .env");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(
    `\n🔌 Connected to: ${mongoose.connection.host}/${mongoose.connection.name}`,
  );

  const total = await db.collection("songs").countDocuments();
  console.log(`📦 ${total} songs to process`);

  let processed = 0;
  const cursor = db
    .collection("songs")
    .find({}, { projection: { title: 1, artist: 1 } })
    .batchSize(BATCH_SIZE);

  let bulkOps: any[] = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;

    const { searchWords, searchPrefixes } = buildSearchFields(
      doc.title,
      doc.artist,
    );

    bulkOps.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { searchWords, searchPrefixes } },
      },
    });

    if (bulkOps.length >= BATCH_SIZE) {
      await db.collection("songs").bulkWrite(bulkOps, { ordered: false });
      processed += bulkOps.length;
      bulkOps = [];
      console.log(`   …${processed}/${total}`);
    }
  }

  if (bulkOps.length > 0) {
    await db.collection("songs").bulkWrite(bulkOps, { ordered: false });
    processed += bulkOps.length;
  }

  console.log(`✅ Backfilled ${processed} songs`);

  // ساخت ایندکس‌های جدید (re-run هم امنه)
  await db
    .collection("songs")
    .createIndex(
      { searchWords: 1 },
      { name: "songs_search_words", background: true },
    );
  await db
    .collection("songs")
    .createIndex(
      { searchPrefixes: 1 },
      { name: "songs_search_prefixes", background: true },
    );
  await db
    .collection("songs")
    .createIndex(
      { channelUsername: 1, searchWords: 1 },
      { name: "songs_channel_search_words", background: true },
    );
  await db
    .collection("songs")
    .createIndex(
      { channelUsername: 1, searchPrefixes: 1 },
      { name: "songs_channel_search_prefixes", background: true },
    );
  console.log("✅ Indexes created");

  // text index قدیمی دیگه استفاده نمی‌شه — اگه خواستی فضا آزاد کنی:
  // await db.collection("songs").dropIndex("songs_text_search");

  await mongoose.disconnect();
  console.log("\n✅ Done — connection closed.");
}

backfill().catch((err) => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});