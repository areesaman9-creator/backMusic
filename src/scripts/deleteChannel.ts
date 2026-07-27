/**
 * حذف کامل یک کانال و همه‌ی آهنگ‌های مرتبط باهاش از دیتابیس.
 *
 * اجرا:
 *   npx ts-node src/scripts/deleteChannel.ts <channelId-or-username> [--dry-run]
 *
 * مثال‌ها:
 *   npx ts-node src/scripts/deleteChannel.ts 65f1a2b3c4d5e6f7a8b9c0d1
 *   npx ts-node src/scripts/deleteChannel.ts @music_channel
 *   npx ts-node src/scripts/deleteChannel.ts music_channel --dry-run
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const DRY_RUN = process.argv.includes("--dry-run");

async function run() {
  const arg = process.argv[2];
  if (!arg || arg.startsWith("--")) {
    console.error(
      "❌ Usage: npx ts-node src/scripts/deleteChannel.ts <channelId-or-username> [--dry-run]",
    );
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(
    `🔌 Connected: ${mongoose.connection.host}/${mongoose.connection.name}`,
  );
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}\n`);

  // ── پیدا کردن کانال بر اساس _id یا channelUsername ─────────────
  let channel: any = null;

  if (/^[a-f\d]{24}$/i.test(arg)) {
    channel = await db
      .collection("channels")
      .findOne({ _id: new mongoose.Types.ObjectId(arg) });
  }

  if (!channel) {
    const username = arg.replace("@", "").trim();
    channel = await db.collection("channels").findOne({ channelUsername: username });
  }

  if (!channel) {
    console.error(`❌ No channel found matching "${arg}"`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const { _id, channelUsername, channelName } = channel;
  console.log(`📻 Found channel: ${channelName} (@${channelUsername})  id=${_id}`);

  const [songsCount, userChannelsCount] = await Promise.all([
    db.collection("songs").countDocuments({ channelUsername }),
    db.collection("user_channels").countDocuments({ channelUsername }),
  ]);

  console.log(`   Songs to delete:              ${songsCount}`);
  console.log(`   User subscriptions to unlink:  ${userChannelsCount}\n`);

  if (DRY_RUN) {
    console.log("⚠️  DRY RUN — nothing was deleted. Run without --dry-run to apply.");
    await mongoose.disconnect();
    return;
  }

  const [channelResult, songsResult, userChannelsResult] = await Promise.all([
    db.collection("channels").deleteOne({ _id }),
    db.collection("songs").deleteMany({ channelUsername }),
    db.collection("user_channels").deleteMany({ channelUsername }),
  ]);

  // پاک‌سازی رفرنس‌های جانبی
  await Promise.all([
    db.collection("default_channels").deleteMany({ channelUsername }),
    db.collection("user_deleted_default_channels").deleteMany({ channelUsername }),
  ]);

  console.log("✅ Done:");
  console.log(`   channels deleted:      ${channelResult.deletedCount}`);
  console.log(`   songs deleted:         ${songsResult.deletedCount}`);
  console.log(`   user_channels deleted: ${userChannelsResult.deletedCount}`);

  await mongoose.disconnect();
  console.log("\n🔌 Disconnected.");
}

run().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});