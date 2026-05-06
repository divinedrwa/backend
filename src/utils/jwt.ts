import jwt from "jsonwebtoken";
import { UserRole } from "@prisma/client";
import { env } from "../config/env";

export type JwtPayload = {
  userId: string;
  role: UserRole;
  /** Only SUPER_ADMIN has null/undefined; tenant users always have a string. */
  societyId?: string | null;
  villaId?: string | null;
};

export function signAuthToken(payload: JwtPayload): string {
  if (
    payload.role !== UserRole.SUPER_ADMIN &&
    (payload.societyId == null || payload.societyId === "")
  ) {
    throw new Error("Tenant auth token requires societyId");
  }
  const body: Record<string, unknown> = {
    userId: payload.userId,
    role: payload.role,
    villaId: payload.villaId ?? null,
  };
  if (payload.role === UserRole.SUPER_ADMIN) {
    body.societyId = null;
  } else {
    body.societyId = payload.societyId;
  }
  return jwt.sign(body, env.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyAuthToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}
