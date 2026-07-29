import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") return next(); 

  const start = Date.now();
  res.on("finish", () => {
    const user = (req as any).user;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, {
      telegramId: user?.telegramId ?? null,
      telegramUsername: user?.telegramUsername ?? null,
      userId: user?._id?.toString() ?? null,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
};