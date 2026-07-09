/**
 * Run once:  npx ts-node src/scripts/createIndexes.ts
 *
 * Safe to re-run — MongoDB skips existing indexes automatically.
 */
import mongoose from "mongoose";
import "dotenv/config";

async function createIndexes() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set in .env");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(
    `\n🔌 Connected to: ${mongoose.connection.host}/${mongoose.connection.name}`,
  );

  /* ─────────────────────────────────────────────
     telegram_songs  (heaviest collection)
  ───────────────────────────────────────────── */
  await db.collection("telegram_songs").createIndex(
    { title: "text", artist: "text" },
    {
      weights: { title: 2, artist: 1 },
      name: "songs_text_search",
      background: true,
    },
  );
  console.log("✅ songs: text search index");

  // channels (shared)
  await db
    .collection("channels")
    .createIndex(
      { channelUsername: 1 },
      { unique: true, name: "channels_username_unique", background: true },
    );
  await db
    .collection("channels")
    .createIndex({ status: 1 }, { name: "channels_status", background: true });

  // songs (shared)
  await db
    .collection("songs")
    .createIndex(
      { channelUsername: 1, messageId: 1 },
      { unique: true, name: "songs_channel_msgid_unique", background: true },
    );
  await db
    .collection("songs")
    .createIndex(
      { channelUsername: 1, messageDate: -1 },
      { name: "songs_channel_date", background: true },
    );
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

  // user_channels (per-user mapping)
  await db
    .collection("user_channels")
    .createIndex(
      { userId: 1, channelUsername: 1 },
      { unique: true, name: "user_channels_unique", background: true },
    );
  await db
    .collection("user_channels")
    .createIndex(
      { userId: 1, addedAt: -1 },
      { name: "user_channels_user_date", background: true },
    );

  /* ─────────────────────────────────────────────
     user_favorites
  ───────────────────────────────────────────── */
  await db
    .collection("user_favorites")
    .createIndex(
      { userId: 1, addedAt: -1 },
      { name: "favorites_user_date", background: true },
    );
  console.log("✅ favorites: userId + addedAt");

  await db
    .collection("user_favorites")
    .createIndex(
      { userId: 1, songId: 1 },
      { unique: true, name: "favorites_user_song_unique", background: true },
    );

  /* ─────────────────────────────────────────────
     user_playlists
  ───────────────────────────────────────────── */
  await db
    .collection("user_playlists")
    .createIndex(
      { userId: 1, updatedAt: -1 },
      { name: "playlists_user_date", background: true },
    );

  await db
    .collection("play_history")
    .createIndex(
      { userId: 1, songId: 1 },
      { unique: true, name: "play_history_user_song_unique", background: true },
    );
  await db
    .collection("play_history")
    .createIndex(
      { userId: 1, playCount: -1 },
      { name: "play_history_user_count", background: true },
    );
  await db
    .collection("play_history")
    .createIndex(
      { userId: 1, lastPlayedAt: -1 },
      { name: "play_history_user_recent", background: true },
    );

  /* ─────────────────────────────────────────────
     stream_tokens  —  TTL auto-cleanup
  ───────────────────────────────────────────── */
  await db
    .collection("stream_tokens")
    .createIndex(
      { token: 1 },
      { unique: true, name: "stream_token_unique", background: true },
    );

  await db
    .collection("stream_tokens")
    .createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "stream_tokens_ttl", background: true },
    );

  /* ─────────────────────────────────────────────
     default_channels
  ───────────────────────────────────────────── */
  await db.collection("default_channels").createIndex(
    { channelUsername: 1 },
    {
      unique: true,
      name: "default_channels_username_unique",
      background: true,
    },
  );

  await db
    .collection("user_deleted_default_channels")
    .createIndex(
      { userId: 1, channelUsername: 1 },
      { unique: true, name: "user_deleted_defaults_unique", background: true },
    );

  /* ─────────────────────────────────────────────
     Summary
  ───────────────────────────────────────────── */

  // Print index report
  const collections = [
    "channels",
    "songs",
    "user_channels",
    "user_favorites",
    "user_playlists",
    "stream_tokens",
    "default_channels",
  ];

  for (const col of collections) {
    const indexes = await db.collection(col).indexes();
    console.log(`📋 ${col}:`);
    for (const idx of indexes) {
      console.log(`   - ${idx.name}:`, JSON.stringify(idx.key));
    }
  }

  await mongoose.disconnect();
  console.log("\n✅ Done — connection closed.");
}

createIndexes().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
