/**
 * اجرا:
 *   npx ts-node src/scripts/fixOversizedThumbnails.ts
 *
 * thumbnailهایی که به‌خاطر باگ قدیمی getDocumentThumbnail به‌جای عکس،
 * کل فایل صوتی رو ذخیره کرده بودن رو پیدا و null می‌کنه.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const MAX_THUMB_LEN = 300_000; // ~225KB باینری

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`🔌 Connected: ${mongoose.connection.host}/${mongoose.connection.name}`);

  const result = await db.collection("songs").updateMany(
    { $expr: { $gt: [{ $strLenBytes: { $ifNull: ["$thumbnail", ""] } }, MAX_THUMB_LEN] } },
    { $set: { thumbnail: null } },
  );

  console.log(`✅ Fixed ${result.modifiedCount} song(s) with oversized thumbnail`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});