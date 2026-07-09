import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const rawKey = req.headers["x-admin-key"];
  const secret = process.env.ADMIN_SECRET;

  if (!secret) {
    return res.status(500).json({ success: false, message: "ADMIN_SECRET not configured on server" });
  }

  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  if (!key || !timingSafeEqualStrings(key, secret)) {
    return res.status(401).json({ success: false, message: "Invalid admin key" });
  }
  next();
};

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");


  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}