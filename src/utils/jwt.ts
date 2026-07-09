import jwt from "jsonwebtoken";

export const generateToken = (payload: object, expiresIn: string = "7d"): string => {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn } as any);
};

export const verifyToken = (token: string): any => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET as string);
  } catch {
    throw new Error("Invalid or expired token");
  }
};

export const generateAuthTokens = (user: any, sessionId: string) => {
  const payload = { id: user._id, email: user.email, sid: sessionId };
  return {
    accessToken: generateToken(payload, "15m"),
    refreshToken: generateToken(payload, "30d"),
  };
};