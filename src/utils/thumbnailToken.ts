import crypto from "crypto";

const SECRET = process.env.THUMBNAIL_SIGNING_SECRET || process.env.JWT_SECRET!;
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || "";
const DAY_MS = 24 * 60 * 60 * 1000;

function sign(songId: string, exp: number): string {
  return crypto.createHmac("sha256", SECRET).update(`${songId}:${exp}`).digest("hex");
}

function dayBoundaryExp(): number {
  return Math.ceil(Date.now() / DAY_MS) * DAY_MS + DAY_MS;
}

export function signThumbnailUrl(songId: string): string {
  const exp = dayBoundaryExp();
  const sig = sign(songId, exp);
  return `${PUBLIC_API_URL}/songs/${songId}/thumbnail?exp=${exp}&sig=${sig}`;
}

export function verifyThumbnailToken(songId: string, exp: number, sig: string): boolean {
  if (!exp || !sig || Date.now() > exp) return false;
  const expected = sign(songId, exp);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}