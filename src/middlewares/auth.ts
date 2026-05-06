import { NextFunction, Request, Response } from "express";
import { SocietyStatus, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { verifyAuthToken } from "../utils/jwt";

const SUPER_ALLOWED_PATH_PREFIXES = ["/api/auth", "/api/public", "/api/super"];

function isSuperAdminAllowedPath(req: Request): boolean {
  const path = req.originalUrl.split("?")[0] ?? "";
  return SUPER_ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * Verifies JWT, reconciles with DB (role + society), and blocks token tampering.
 * Super admin tokens may only call /api/auth, /api/public, /api/super.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const token = authHeader.slice(7);
  let payload: ReturnType<typeof verifyAuthToken>;
  try {
    payload = verifyAuthToken(token);
  } catch {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        isActive: true,
        role: true,
        societyId: true,
        villaId: true,
        society: { select: { status: true } },
      },
    });

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
      if (
        user.society?.status === SocietyStatus.INACTIVE &&
        user.role !== UserRole.ADMIN
      ) {
        res.status(403).json({ message: "Society is inactive" });
        return;
      }
    }

    req.auth = {
      userId: user.id,
      role: user.role,
      /** Empty for SUPER_ADMIN — tenant-only routes must still treat falsy as forbidden. */
      societyId: user.societyId ?? "",
      villaId: user.villaId,
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

export function requireRole(...roles: (UserRole | string)[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.auth.role)) {
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
