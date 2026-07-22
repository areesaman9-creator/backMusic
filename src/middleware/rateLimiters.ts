// import rateLimit from "express-rate-limit";

// export const authLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, 
//   max: 10,                 
//   message: { success: false, message: "Too many attempts. Please try again later." },
//   standardHeaders: true,
//   legacyHeaders: false,
// });

import { Request, Response, NextFunction } from "express";

// Rate limiter موقتاً غیرفعال شده
export const authLimiter = (req: Request, res: Response, next: NextFunction) => {
  next();
};