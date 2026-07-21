import mongoose from "mongoose";

export interface GlobalPromo {
  active: boolean;
  endDate: Date | null;
}

let cached: GlobalPromo = { active: false, endDate: null };
let lastFetch = 0;
const TTL_MS = 15_000;

export async function getGlobalPromo(): Promise<GlobalPromo> {
  const now = Date.now();
  if (now - lastFetch < TTL_MS) return cached;

  try {
    const db = mongoose.connection.db;
    const doc = await db
      .collection("app_settings")
      .findOne({ _id: "global_promotion" as any });

    cached = {
      active:
        !!doc?.active && !!doc?.endDate && new Date(doc.endDate) > new Date(),
      endDate: doc?.endDate ? new Date(doc.endDate) : null,
    };
  } catch {
  }
  lastFetch = now;
  return cached;
}