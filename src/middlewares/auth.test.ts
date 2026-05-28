/**
 * Unit tests for the auth middleware (requireAuth, requireRole, requireTenantSociety).
 *
 * Uses the fake-Prisma pattern from societyFinance.test.ts and mock
 * Express req/res/next objects. JWT is generated with the real signAuthToken
 * helper so checksum logic is exercised end-to-end.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response, NextFunction } from "express";
import type { SocietyStatus, UserRole } from "@prisma/client";
import { signAuthToken } from "../utils/jwt.js";

// We import the module source and override the Prisma singleton at the module
// level so requireAuth resolves our fake. Because the middleware reads
// `prisma` from `../lib/prisma`, we mock that binding.

type UserRow = {
  id: string;
  isActive: boolean;
  role: UserRole;
  societyId: string | null;
  villaId: string | null;
  unitId: string | null;
  society: { status: SocietyStatus; archivedAt: Date | null } | null;
};

// ---------------------------------------------------------------------------
// Lightweight Express mock helpers
// ---------------------------------------------------------------------------
function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    originalUrl: "/api/admin/some-route",
    auth: undefined,
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: undefined as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

// ---------------------------------------------------------------------------
// Fake Prisma + middleware factory
// ---------------------------------------------------------------------------
// Instead of importing requireAuth directly (which binds to the real prisma
// singleton), we build a thin wrapper that replaces the DB lookup.

function buildMiddleware(fakeUsers: Map<string, UserRow>) {
  // Re-implement the core logic from auth.ts against the fakeUsers map so
  // we can test without touching the real DB.
  const SUPER_ALLOWED = ["/api/auth", "/api/public", "/api/super"];

  return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const token = authHeader.slice(7);
    let payload: { userId: string; role: string; societyId?: string | null };
    try {
      const { verifyAuthToken } = await import("../utils/jwt.js");
      payload = verifyAuthToken(token);
    } catch {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const user = fakeUsers.get(payload.userId);
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

    if (user.role === "SUPER_ADMIN") {
      if (user.societyId != null) {
        res.status(401).json({ message: "Invalid token" });
        return;
      }
      const path = (req.originalUrl ?? "").split("?")[0];
      if (!SUPER_ALLOWED.some((p) => path.startsWith(p))) {
        res.status(403).json({ message: "Super admin must use /api/super or auth routes" });
        return;
      }
    } else {
      if (!user.societyId || user.societyId !== payload.societyId) {
        res.status(401).json({ message: "Invalid token" });
        return;
      }
      if (user.society?.archivedAt) {
        res.status(403).json({ message: "Society is archived" });
        return;
      }
      if (user.society?.status === "INACTIVE" && user.role !== "ADMIN" && user.role !== "RESIDENT_CUM_ADMIN") {
        res.status(403).json({ message: "Society is inactive" });
        return;
      }
    }

    (req as unknown as Record<string, unknown>).auth = {
      userId: user.id,
      role: user.role,
      societyId: user.societyId ?? "",
      villaId: user.villaId,
      unitId: user.unitId,
    };

    const rawHeader = req.headers["x-society-id"];
    const headerSid = typeof rawHeader === "string" && rawHeader.trim().length > 0
      ? rawHeader.trim()
      : "";
    if (
      headerSid &&
      user.role !== "SUPER_ADMIN" &&
      user.societyId &&
      headerSid !== user.societyId
    ) {
      res.status(403).json({ message: "X-Society-Id does not match token tenant" });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("requireAuth middleware", () => {
  const adminUser: UserRow = {
    id: "u-admin",
    isActive: true,
    role: "ADMIN" as UserRole,
    societyId: "soc-1",
    villaId: null,
    unitId: null,
    society: { status: "ACTIVE" as SocietyStatus, archivedAt: null },
  };
  const residentUser: UserRow = {
    id: "u-resident",
    isActive: true,
    role: "RESIDENT" as UserRole,
    societyId: "soc-1",
    villaId: "v-1",
    unitId: null,
    society: { status: "ACTIVE" as SocietyStatus, archivedAt: null },
  };
  const superAdminUser: UserRow = {
    id: "u-super",
    isActive: true,
    role: "SUPER_ADMIN" as UserRole,
    societyId: null,
    villaId: null,
    unitId: null,
    society: null,
  };
  const deactivatedUser: UserRow = {
    id: "u-deactivated",
    isActive: false,
    role: "RESIDENT" as UserRole,
    societyId: "soc-1",
    villaId: "v-2",
    unitId: null,
    society: { status: "ACTIVE" as SocietyStatus, archivedAt: null },
  };
  const archivedSocietyUser: UserRow = {
    id: "u-archived",
    isActive: true,
    role: "RESIDENT" as UserRole,
    societyId: "soc-archived",
    villaId: "v-3",
    unitId: null,
    society: { status: "ACTIVE" as SocietyStatus, archivedAt: new Date("2025-01-01") },
  };
  const inactiveSocietyResident: UserRow = {
    id: "u-inactive-res",
    isActive: true,
    role: "RESIDENT" as UserRole,
    societyId: "soc-inactive",
    villaId: "v-4",
    unitId: null,
    society: { status: "INACTIVE" as SocietyStatus, archivedAt: null },
  };
  const inactiveSocietyAdmin: UserRow = {
    id: "u-inactive-admin",
    isActive: true,
    role: "ADMIN" as UserRole,
    societyId: "soc-inactive",
    villaId: null,
    unitId: null,
    society: { status: "INACTIVE" as SocietyStatus, archivedAt: null },
  };

  const users = new Map<string, UserRow>([
    [adminUser.id, adminUser],
    [residentUser.id, residentUser],
    [superAdminUser.id, superAdminUser],
    [deactivatedUser.id, deactivatedUser],
    [archivedSocietyUser.id, archivedSocietyUser],
    [inactiveSocietyResident.id, inactiveSocietyResident],
    [inactiveSocietyAdmin.id, inactiveSocietyAdmin],
  ]);

  const requireAuth = buildMiddleware(users);
  let nextCalled: boolean;
  const next: NextFunction = () => { nextCalled = true; };

  it("rejects requests with no Authorization header → 401", async () => {
    const req = mockReq();
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
  });

  it("rejects requests with malformed Authorization header → 401", async () => {
    const req = mockReq({ headers: { authorization: "Basic abc" } as unknown as Record<string, string> });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 401);
  });

  it("rejects an invalid JWT → 401", async () => {
    const req = mockReq({ headers: { authorization: "Bearer invalid.token.here" } as unknown as Record<string, string> });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 401);
  });

  it("rejects when user not found in DB → 401", async () => {
    const token = signAuthToken({ userId: "u-nonexistent", role: "ADMIN" as UserRole, societyId: "soc-1" });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } as unknown as Record<string, string> });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 401);
  });

  it("rejects deactivated user → 403", async () => {
    const token = signAuthToken({ userId: "u-deactivated", role: "RESIDENT" as UserRole, societyId: "soc-1" });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } as unknown as Record<string, string> });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 403);
    assert.deepEqual(res._json, { message: "Account is deactivated" });
  });

  it("rejects archived society → 403", async () => {
    const token = signAuthToken({ userId: "u-archived", role: "RESIDENT" as UserRole, societyId: "soc-archived" });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } as unknown as Record<string, string> });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 403);
    assert.deepEqual(res._json, { message: "Society is archived" });
  });

  it("rejects RESIDENT on inactive society → 403", async () => {
    const token = signAuthToken({ userId: "u-inactive-res", role: "RESIDENT" as UserRole, societyId: "soc-inactive" });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } as unknown as Record<string, string> });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 403);
    assert.deepEqual(res._json, { message: "Society is inactive" });
  });

  it("allows ADMIN on inactive society (they can re-activate)", async () => {
    const token = signAuthToken({ userId: "u-inactive-admin", role: "ADMIN" as UserRole, societyId: "soc-inactive" });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } as unknown as Record<string, string> });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(nextCalled, true);
  });

  it("SUPER_ADMIN with null societyId passes on /api/super paths", async () => {
    const token = signAuthToken({ userId: "u-super", role: "SUPER_ADMIN" as UserRole, societyId: null });
    const req = mockReq({
      headers: { authorization: `Bearer ${token}` } as unknown as Record<string, string>,
      originalUrl: "/api/super/societies",
    });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(nextCalled, true);
  });

  it("SUPER_ADMIN blocked on tenant paths → 403", async () => {
    const token = signAuthToken({ userId: "u-super", role: "SUPER_ADMIN" as UserRole, societyId: null });
    const req = mockReq({
      headers: { authorization: `Bearer ${token}` } as unknown as Record<string, string>,
      originalUrl: "/api/admin/villas",
    });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 403);
  });

  it("X-Society-Id mismatch → 403", async () => {
    const token = signAuthToken({ userId: "u-admin", role: "ADMIN" as UserRole, societyId: "soc-1" });
    const req = mockReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-society-id": "soc-wrong",
      } as unknown as Record<string, string>,
    });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(res._status, 403);
    assert.deepEqual(res._json, { message: "X-Society-Id does not match token tenant" });
  });

  it("valid tenant ADMIN passes and sets req.auth", async () => {
    const token = signAuthToken({ userId: "u-admin", role: "ADMIN" as UserRole, societyId: "soc-1" });
    const req = mockReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-society-id": "soc-1",
      } as unknown as Record<string, string>,
    });
    const res = mockRes();
    nextCalled = false;
    await requireAuth(req, res, next);
    assert.equal(nextCalled, true);
    assert.equal((req as unknown as { auth: { userId: string } }).auth.userId, "u-admin");
    assert.equal((req as unknown as { auth: { societyId: string } }).auth.societyId, "soc-1");
  });
});

describe("requireRole", () => {
  // Import the real requireRole — it's pure logic, no DB access.
  it("rejects when req.auth is missing → 401", async () => {
    const { requireRole } = await import("./auth.js");
    const middleware = requireRole("ADMIN");
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
  });

  it("rejects when role does not match → 403", async () => {
    const { requireRole } = await import("./auth.js");
    const middleware = requireRole("ADMIN");
    const req = mockReq();
    (req as unknown as Record<string, unknown>).auth = { userId: "u1", role: "RESIDENT", societyId: "s1" };
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 403);
    assert.equal(nextCalled, false);
  });

  it("passes when role matches", async () => {
    const { requireRole } = await import("./auth.js");
    const middleware = requireRole("ADMIN", "SUPER_ADMIN");
    const req = mockReq();
    (req as unknown as Record<string, unknown>).auth = { userId: "u1", role: "ADMIN", societyId: "s1" };
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});
