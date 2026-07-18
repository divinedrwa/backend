import { UserRole } from "@prisma/client";
import { prisma } from "./prisma";
import { setTenantAuthCookies } from "./tenantAuthCookie";
import { generateRefreshToken, hashRefreshToken, signAuthToken } from "../utils/jwt";

/** Create a hashed refresh token row and return the raw secret. */
async function createRefreshTokenForUser(userId: string): Promise<string> {
  const raw = generateRefreshToken();
  const hashed = hashRefreshToken(raw);
  await prisma.refreshToken.create({
    data: {
      token: hashed,
      userId,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  });
  return raw;
}

export type MintedTenantAuth = {
  token: string;
  refreshToken: string;
  user: {
    id: string;
    username: string;
    name: string;
    email: string;
    phone: string | null;
    role: UserRole;
    societyId: string | null;
    villaId: string | null;
    isActive: boolean;
  };
};

/**
 * Mint tenant access + refresh tokens for impersonation / platform-view flows.
 * Sets HttpOnly cookies when TENANT_HTTPONLY_AUTH is enabled (production default).
 */
export async function mintTenantAuthForUser(
  userId: string,
  res: { setHeader: (name: string, value: string | string[]) => void },
): Promise<MintedTenantAuth | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true, societyId: { not: null } },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      societyId: true,
      villaId: true,
      isActive: true,
    },
  });
  if (!user?.societyId) return null;

  const token = signAuthToken({
    userId: user.id,
    role: user.role,
    societyId: user.societyId,
    villaId: user.villaId,
  });
  const refreshToken = await createRefreshTokenForUser(user.id);
  setTenantAuthCookies(res as Parameters<typeof setTenantAuthCookies>[0], {
    token,
    refreshToken,
  });

  return { token, refreshToken, user };
}
