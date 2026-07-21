/**
 * حذف تامبنیل‌های base64 قدیمی از DB — بعد از دیپلوی بک‌اند اجرا کن:
 *   npx ts-node src/scripts/stripStoredThumbnails.ts
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`🔌 Connected: ${mongoose.connection.host}/${mongoose.connection.name}`);

  const songsResult = await db
    .collection("songs")
    .updateMany({ thumbnail: { $ne: null } }, { $unset: { thumbnail: "" } });
  console.log(`✅ songs: cleared ${songsResult.modifiedCount} thumbnail(s)`);

  const botSongsResult = await db
    .collection("bot_songs")
    .updateMany({ thumbnail: { $ne: null } }, { $unset: { thumbnail: "" } });
  console.log(`✅ bot_songs: cleared ${botSongsResult.modifiedCount} thumbnail(s)`);

  await mongoose.disconnect();
  console.log("🔌 Disconnected");
}

run().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});