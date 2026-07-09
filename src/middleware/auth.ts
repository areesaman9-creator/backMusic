import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import User from "../models/User";

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }
    const token = authHeader.split(" ")[1];
    const decoded = verifyToken(token);
    const user = await User.findById(decoded.id).select("-password");
    if (!user) return res.status(401).json({ success: false, message: "User not found" });
    if (!user.isActive) return res.status(401).json({ success: false, message: "Account inactive" });
    (req as any).user = user;
    (req as any).sessionId = decoded.sid || null;
    next();
  } catch (error: any) {
    return res.status(401).json({ success: false, message: "Invalid token", error: error.message });
  }
};
