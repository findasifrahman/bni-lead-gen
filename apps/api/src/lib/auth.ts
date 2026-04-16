import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "./env";

export type JwtUser = {
  sub: string;
  email: string;
  role: "USER" | "ADMIN";
};

export type AuthedRequest = Request & {
  user?: JwtUser;
};

export function signJwt(payload: JwtUser, rememberMe = false): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: rememberMe ? "30d" : "12h",
  });
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Missing bearer token" });
    return;
  }

  try {
    const token = header.slice("Bearer ".length);
    req.user = jwt.verify(token, env.jwtSecret) as JwtUser;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "ADMIN") {
    res.status(403).json({ message: "Admin access required" });
    return;
  }
  next();
}
