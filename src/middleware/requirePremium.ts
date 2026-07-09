import { Request, Response, NextFunction } from "express";

export const requirePremium = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  const expiresAt = user?.subscriptionExpiresAt;
  const isPremium = !!expiresAt && new Date(expiresAt) > new Date();

  if (!isPremium) {
    return res.status(403).json({
      success: false,
      message: "Premium subscription required",
    });
  }
  next();
};