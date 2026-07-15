import { NextFunction, Request, Response } from "express";
import { SocietyStatus, SocietySubscriptionStatus, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { verifyAuthToken } from "../utils/jwt";
import { readBearerOrCookieToken } from "../lib/tenantAuthCookie";

// ── Auth user cache ─────────────────────────────────────────────────
// Short-lived in-memory cache for the per-request user+society lookup.
// Saves a DB round-trip + JOIN on every authenticated request (~50-200ms
// on serverless Postgres). TTL is 30s — role/status changes propagate
// within half a minute, which is acceptable since deactivation and
// role changes are rare admin actions.
const AUTH_CACHE_TTL_MS = 30_000;
type AuthCacheEntry = {
  expiresAt: number;
  user: {
    id: string;
    isActive: boolean;
    role: UserRole;
    societyId: string | null;
    villaId: string | null;
    unitId: string | null;
    society: {
      status: SocietyStatus;
      archivedAt: Date | null;
      subscription: { status: SocietySubscriptionStatus; trialEndsAt: Date | null } | null;
    } | null;
  } | null;
};
const authUserCache = new Map<string, AuthCacheEntry>();

// Periodic eviction so the map doesn't grow unbounded (runs every 60s).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authUserCache) {
    if (now > entry.expiresAt) authUserCache.delete(key);
  }
}, 60_000).unref();

async function getAuthUser(userId: string) {
  const now = Date.now();
  const cached = authUserCache.get(userId);
  if (cached && now < cached.expiresAt) return cached.user;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      isActive: true,
      role: true,
      societyId: true,
      villaId: true,
      unitId: true,
      society: {
        select: {
          status: true,
          archivedAt: true,
          subscription: { select: { status: true, trialEndsAt: true } },
        },
      },
    },
  });

  authUserCache.set(userId, { expiresAt: now + AUTH_CACHE_TTL_MS, user });
  return user;
}

/** Evict a user from the auth cache (call on deactivation, role change, etc.). */
export function invalidateAuthCache(userId: string): void {
  authUserCache.delete(userId);
}

/** Evict all cached users for a society (archive/restore/status changes). */
export async function invalidateAuthCacheForSociety(societyId: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { societyId },
    select: { id: true },
  });
  for (const u of users) {
    authUserCache.delete(u.id);
  }
}

const SUPER_ALLOWED_PATH_PREFIXES = ["/api/auth", "/api/public", "/api/super"];

function isSubscriptionBlocked(
  sub: { status: SocietySubscriptionStatus; trialEndsAt: Date | null } | null | undefined,
): boolean {
  if (!sub) return false;
  if (
    sub.status === SocietySubscriptionStatus.SUSPENDED ||
    sub.status === SocietySubscriptionStatus.CANCELLED
  ) {
    return true;
  }
  if (
    sub.status === SocietySubscriptionStatus.TRIAL &&
    sub.trialEndsAt &&
    sub.trialEndsAt.getTime() < Date.now()
  ) {
    return true;
  }
  return false;
}

function isSuperAdminAllowedPath(req: Request): boolean {
  const path = req.originalUrl.split("?")[0] ?? "";
  return SUPER_ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Verifies JWT, reconciles with DB (role + society), and blocks token tampering.
 * Super admin tokens may only call /api/auth, /api/public, /api/super.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readBearerOrCookieToken(
    req.headers.authorization,
    req.headers.cookie,
  );
  if (!token) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  let payload: ReturnType<typeof verifyAuthToken>;
  try {
    payload = verifyAuthToken(token);
  } catch {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const user = await getAuthUser(payload.userId);

    if (!user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({ message: "Account is deactivated" });
      return;
    }

    if (user.role !== payload.role) {
      res.status(401).json({ message: "Invalid token" });
      return;
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      if (user.societyId != null) {
        res.status(401).json({ message: "Invalid token" });
        return;
      }
      if (!isSuperAdminAllowedPath(req)) {
        res.status(403).json({
          message: "Super admin must use /api/super or auth routes",
        });
        return;
      }
    } else {
      if (!user.societyId || user.societyId !== payload.societyId) {
        res.status(401).json({ message: "Invalid token" });
        return;
      }
      // Archived societies are blocked for everyone (including the society
      // ADMIN) — restore-then-act is the workflow. Inactive societies still
      // let ADMIN through so they can re-activate.
      if (user.society?.archivedAt) {
        res.status(403).json({ message: "Society is archived" });
        return;
      }
      if (
        user.society?.status === SocietyStatus.INACTIVE &&
        user.role !== UserRole.ADMIN &&
        user.role !== UserRole.RESIDENT_CUM_ADMIN
      ) {
        res.status(403).json({ message: "Society is inactive" });
        return;
      }
      if (isSubscriptionBlocked(user.society?.subscription)) {
        res.status(403).json({ message: "Society subscription expired" });
        return;
      }
    }

    req.auth = {
      userId: user.id,
      role: user.role,
      /** Empty for SUPER_ADMIN — tenant-only routes must still treat falsy as forbidden. */
      societyId: user.societyId ?? "",
      villaId: user.villaId,
      unitId: user.unitId,
    };

    const rawHeader =
      req.headers["x-society-id"] ?? req.headers["X-Society-Id"];
    const headerSid =
      typeof rawHeader === "string" && rawHeader.trim().length > 0
        ? rawHeader.trim()
        : "";
    if (
      headerSid &&
      req.auth.role !== UserRole.SUPER_ADMIN &&
      req.auth.societyId &&
      headerSid !== req.auth.societyId
    ) {
      res.status(403).json({ message: "X-Society-Id does not match token tenant" });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

function roleMatches(userRole: UserRole | string, allowedRole: UserRole | string): boolean {
  if (userRole === allowedRole) return true;
  if (userRole === UserRole.RESIDENT_CUM_ADMIN) {
    return allowedRole === UserRole.ADMIN || allowedRole === UserRole.RESIDENT;
  }
  return false;
}

export function isAdminLikeRole(role: UserRole | string): boolean {
  return role === UserRole.ADMIN || role === UserRole.RESIDENT_CUM_ADMIN;
}

export function requireRole(...roles: (UserRole | string)[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (!roles.some((r) => roleMatches(req.auth!.role, r))) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    next();
  };
}

/** Society-scoped API guard: tenant users only (explicit check for handlers). */
export function requireTenantSociety(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  if (req.auth.role === UserRole.SUPER_ADMIN || !req.auth.societyId) {
    res.status(403).json({ message: "Tenant context required" });
    return;
  }
  next();
}
