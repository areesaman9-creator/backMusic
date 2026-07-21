import { Request, Response, NextFunction } from "express";
import { computeEffectivePremium } from "../utils/premium";

export const requirePremium = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = (req as any).user;
  const promo = (req as any).globalPromo || { active: false, endDate: null };
  const { isPremium } = computeEffectivePremium(
    user?.subscriptionExpiresAt,
    promo,
    user?.reservedDaysAfterPromo,
  );

  if (!isPremium) {
    return res.status(403).json({
      success: false,
      message: "Premium subscription required",
    });
  }
  next();
};
