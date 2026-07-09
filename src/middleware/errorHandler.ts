import { Request, Response, NextFunction } from "express";

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  if (err.code === 11000) {
    statusCode = 400;
    const field = Object.keys(err.keyPattern || {})[0];
    message = `${field} already exists`;
  }
  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors as any).map((e: any) => e.message).join(", ");
  }
  if (err.name === "CastError") { statusCode = 400; message = "Invalid ID format"; }
  if (err.name === "JsonWebTokenError") { statusCode = 401; message = "Invalid token"; }
  if (err.name === "TokenExpiredError") { statusCode = 401; message = "Token expired"; }

  if (process.env.NODE_ENV === "development") console.error("Error:", err);

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

export const notFound = (req: Request, res: Response, next: NextFunction) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};
