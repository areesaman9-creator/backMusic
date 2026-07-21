import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { verifyToken } from "../utils/jwt";
import User from "../models/User";
import { getGlobalPromo } from "../utils/globalPromoCache";

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }
    const token = authHeader.split(" ")[1];
    const decoded = verifyToken(token);
    const user = await User.findById(decoded.id).select("-password");
    if (!user)
      return res
        .status(401)
        .json({ success: false, message: "User not found" });
    if (!user.isActive)
      return res
        .status(401)
        .json({ success: false, message: "Account inactive" });

    const globalPromo = await getGlobalPromo();
    const now = new Date();
    const promoActive =
      globalPromo.active && !!globalPromo.endDate && globalPromo.endDate > now;

    const reserved = (user as any).reservedDaysAfterPromo;
    if (!promoActive && reserved && reserved > 0) {
      const newExpiry = new Date(
        now.getTime() + reserved * 24 * 60 * 60 * 1000,
      );
      await mongoose.connection.db.collection("users").updateOne(
        { _id: user._id },
        {
          $set: { subscriptionExpiresAt: newExpiry },
          $unset: { reservedDaysAfterPromo: "" },
        },
      );
      (user as any).subscriptionExpiresAt = newExpiry;
      (user as any).reservedDaysAfterPromo = null;
    }

    (req as any).user = user;
    (req as any).sessionId = decoded.sid || null;
    (req as any).globalPromo = globalPromo;
    next();
  } catch (error: any) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid token", error: error.message });
  }
};
