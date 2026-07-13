/**
 * Migrates user_playlists from single-owner model to shared model:
 *   userId (string)  →  ownerId (string) + userIds (string[])
 *   description       →  removed
 *
 * Run once:
 *   npx ts-node src/scripts/migratePlaylistsToSharedModel.ts
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({
  path: ".env.local",
});

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set in .env");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`\n🔌 Connected to: ${mongoose.connection.host}/${mongoose.connection.name}`);

  const cursor = db.collection("user_playlists").find({ userId: { $exists: true } });
  let migrated = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;

    await db.collection("user_playlists").updateOne(
      { _id: doc._id },
      {
        $set: { ownerId: doc.userId, userIds: [doc.userId] },
        $unset: { userId: "", description: "" },
      },
    );
    migrated++;
  }

  console.log(`✅ Migrated ${migrated} playlists`);
  await mongoose.disconnect();
  console.log("🔌 Disconnected\n");
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});