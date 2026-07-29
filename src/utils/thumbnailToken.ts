import crypto from "crypto";

const SECRET = process.env.THUMBNAIL_SIGNING_SECRET || process.env.JWT_SECRET!;
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || "";
const DAY_MS = 24 * 60 * 60 * 1000;

function sign(songId: string, exp: number, uid: string): string {
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${songId}:${exp}:${uid}`)
    .digest("hex");
}

function dayBoundaryExp(): number {
  return Math.ceil(Date.now() / DAY_MS) * DAY_MS + DAY_MS;
}

export function signThumbnailUrl(
  songId: string,
  userId?: string | null,
): string {
  const exp = dayBoundaryExp();
  const uid = userId || "";
  const sig = sign(songId, exp, uid);
  const uidParam = uid ? `&uid=${encodeURIComponent(uid)}` : "";
  return `${PUBLIC_API_URL}/songs/${songId}/thumbnail?exp=${exp}&sig=${sig}${uidParam}`;
}

export function verifyThumbnailToken(
  songId: string,
  exp: number,
  sig: string,
  uid: string = "",
): boolean {
  if (!exp || !sig || Date.now() > exp) return false;
  const expected = sign(songId, exp, uid);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
