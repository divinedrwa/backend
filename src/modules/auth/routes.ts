import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  InvitationStatus,
  Prisma,
  ResidentType,
  SocietyStatus,
  UserRole,
} from "@prisma/client";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { validateBody } from "../../middlewares/validate";
import crypto from "crypto";
import { signAuthToken, generateRefreshToken, hashRefreshToken } from "../../utils/jwt";
import { passwordSchema } from "../../lib/passwordSchema";
import {
  throttleKey,
  checkLoginThrottle,
  recordLoginFailure,
  clearLoginThrottle,
} from "../../lib/loginThrottle";
import { sendPasswordResetEmail } from "../../services/email.service";

const router = Router();

/**
 * Rate limit credential checks per IP. Tuned for human typing rate, not
 * automated stuffing: 20 attempts / 15 min returns 429. Combined with
 * `app.set("trust proxy", 1)`, the limiter sees the real client IP behind
 * the standard one-hop reverse proxy.
 */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    message: "Too many login attempts. Please wait a few minutes and try again.",
  },
});

const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    message: "Too many token refresh attempts. Please try again later.",
  },
});

const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    message: "Too many registration attempts. Please try again later.",
  },
});

class InviteRegisterError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "InviteRegisterError";
  }
}

function normalizePhone(p: string): string {
  return p.replace(/\s+/g, "").trim();
}

async function applyLoginDevice(opts: {
  userId: string;
  fcmToken?: string | null;
  deviceId?: string | null;
  deviceType?: "ANDROID" | "IOS" | "WEB" | null;
  deviceName?: string | null;
}): Promise<void> {
  const { userId, fcmToken, deviceId, deviceType, deviceName } = opts;
  if (!fcmToken || !deviceId || !deviceType) {
    return;
  }
  try {
    await prisma.pushDevice.upsert({
      where: {
        userId_deviceId: {
          userId,
          deviceId,
        },
      },
      create: {
        userId,
        token: fcmToken,
        deviceId,
        deviceType,
        deviceName: deviceName || "Unknown Device",
        platform: deviceType === "IOS" ? "IOS" : "ANDROID",
        isActive: true,
        lastUsedAt: new Date(),
      },
      update: {
        token: fcmToken,
        deviceName: deviceName,
        isActive: true,
        lastUsedAt: new Date(),
      },
    });
  } catch (deviceError) {
    // Device token registration is best-effort during login. Failure must
    // not break sign-in; log without leaking the FCM token itself.
    logger.error({ userId, deviceId, deviceType }, "[auth] device token upsert failed");
  }
}

const registerWithInvitationSchema = z.object({
  token: z.string().min(16),
  username: z.string().trim().min(3).max(50),
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  password: passwordSchema,
  phone: z.string().trim().optional(),
  villaId: z.string().optional(),
  fcmToken: z.string().nullable().optional(),
  deviceId: z.string().nullable().optional(),
  deviceType: z.enum(["ANDROID", "IOS", "WEB"]).nullable().optional(),
  deviceName: z.string().nullable().optional(),
});

const loginUserInclude = {
  villa: {
    select: {
      id: true,
      villaNumber: true,
      block: true,
    },
  },
  society: {
    select: {
      id: true,
      name: true,
      status: true,
    },
  },
} as const;

function identifierWhere(identifier: string) {
  return {
    OR: [
      { username: { equals: identifier, mode: "insensitive" as const } },
      { email: { equals: identifier, mode: "insensitive" as const } },
      { phone: identifier },
    ],
  };
}

/** Create a hashed refresh token row in the DB and return the raw token. */
async function createRefreshTokenForUser(userId: string): Promise<string> {
  const raw = generateRefreshToken();
  const hashed = hashRefreshToken(raw);
  await prisma.refreshToken.create({
    data: {
      token: hashed,
      userId,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
    },
  });
  return raw;
}

async function serializeAuthUser(user: {
  id: string;
  username: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  societyId: string | null;
  villaId: string | null;
  isActive: boolean;
  createdAt: Date;
  photoUrl: string | null;
  residentType: ResidentType | null;
  notifyEmail: boolean;
  notifyPush: boolean;
  moveInDate: Date | null;
  moveOutDate: Date | null;
  villa: { id: string; villaNumber: string | null; block: string | null } | null;
  society: { id: string; name: string; status: SocietyStatus } | null;
}) {
  const token = signAuthToken({
    userId: user.id,
    societyId: user.societyId,
    role: user.role,
    villaId: user.villaId,
  });
  const refreshToken = await createRefreshTokenForUser(user.id);
  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      societyId: user.societyId,
      villaId: user.villaId,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
      photoUrl: user.photoUrl ?? null,
      residentType: user.residentType ?? null,
      notifyEmail: user.notifyEmail,
      notifyPush: user.notifyPush,
      moveInDate: user.moveInDate?.toISOString() ?? null,
      moveOutDate: user.moveOutDate?.toISOString() ?? null,
      villa: user.villa
        ? {
            id: user.villa.id,
            villaNumber: user.villa.villaNumber,
            block: user.villa.block,
          }
        : null,
      society: user.society
        ? {
            id: user.society.id,
            name: user.society.name,
            status: user.society.status,
          }
        : null,
    },
  };
}

/**
 * POST /auth/logout — revoke the caller's refresh tokens.
 *
 * Accepts an optional `refreshToken` in the body.  If provided, only that
 * single token is revoked (single-device logout).  Otherwise, ALL of the
 * user's tokens are revoked (logout everywhere).
 *
 * The endpoint is lenient: if the token isn't found or is already revoked
 * the request still succeeds with 204 so clients can fire-and-forget.
 */
const logoutSchema = z
  .object({ refreshToken: z.string().optional() })
  .optional();

router.post("/logout", validateBody(logoutSchema), async (req, res, next) => {
  try {
    // Best-effort: extract userId from the Authorization header if present.
    let userId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const jwt = await import("jsonwebtoken");
        const payload = jwt.default.decode(authHeader.slice(7)) as { userId?: string } | null;
        userId = payload?.userId ?? null;
      } catch {
        // Token may be expired — that's fine, we still try.
      }
    }

    const body = (req.body ?? {}) as { refreshToken?: string };

    if (body.refreshToken) {
      // Revoke the specific refresh token.
      const hashed = hashRefreshToken(body.refreshToken);
      await prisma.refreshToken.updateMany({
        where: { token: hashed, revoked: false },
        data: { revoked: true },
      });
    } else if (userId) {
      // No specific token provided — revoke ALL tokens for this user.
      await prisma.refreshToken.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });
    }

    return res.status(204).send();
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/register-with-invitation — public; completes a pending invite.
 */
router.post(
  "/register-with-invitation",
  registerRateLimiter,
  validateBody(registerWithInvitationSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof registerWithInvitationSchema>;

      const result = await prisma.$transaction(async (tx) => {
        const inv = await tx.invitation.findUnique({
          where: { token: body.token },
          include: { society: { select: { id: true, status: true, name: true } } },
        });

        if (!inv || inv.status !== InvitationStatus.PENDING) {
          throw new InviteRegisterError(400, "Invitation is not valid");
        }

        if (inv.expiresAt <= new Date()) {
          await tx.invitation.updateMany({
            where: { id: inv.id, status: InvitationStatus.PENDING },
            data: { status: InvitationStatus.EXPIRED },
          });
          throw new InviteRegisterError(400, "Invitation has expired");
        }

        if (inv.society.status === SocietyStatus.INACTIVE) {
          throw new InviteRegisterError(403, "Society is inactive");
        }

        if (inv.email) {
          const want = inv.email.toLowerCase().trim();
          if (body.email.trim().toLowerCase() !== want) {
            throw new InviteRegisterError(400, "Email must match the invitation");
          }
        }

        const phoneValue: string | null = body.phone?.trim() || null;
        if (inv.phone) {
          if (!phoneValue) {
            throw new InviteRegisterError(400, "Phone is required for this invitation");
          }
          if (normalizePhone(phoneValue) !== normalizePhone(inv.phone)) {
            throw new InviteRegisterError(400, "Phone must match the invitation");
          }
        }

        const existingUser = await tx.user.findFirst({
          where: {
            OR: [
              { username: { equals: body.username, mode: "insensitive" } },
              { email: { equals: body.email, mode: "insensitive" } },
            ],
          },
        });
        if (existingUser) {
          throw new InviteRegisterError(409, "Username or email already in use");
        }

        let villaId: string | null = null;
        if (inv.role === UserRole.RESIDENT || inv.role === UserRole.RESIDENT_CUM_ADMIN) {
          const invitedVillaId = inv.villaId?.trim() ?? null;
          const bodyVillaId = body.villaId?.trim() ?? null;

          if (invitedVillaId) {
            if (bodyVillaId && bodyVillaId !== invitedVillaId) {
              throw new InviteRegisterError(
                400,
                "This invitation assigns a villa — do not send a different villaId",
              );
            }
            const villa = await tx.villa.findFirst({
              where: { id: invitedVillaId, societyId: inv.societyId },
              select: { id: true },
            });
            if (!villa) {
              throw new InviteRegisterError(
                400,
                "Invitation villa is no longer valid — ask your admin for a new invite",
              );
            }
            villaId = villa.id;
          } else if (bodyVillaId) {
            const villa = await tx.villa.findFirst({
              where: { id: bodyVillaId, societyId: inv.societyId },
              select: { id: true },
            });
            if (!villa) {
              throw new InviteRegisterError(400, "Villa not found in this society");
            }
            villaId = villa.id;
          }
        }

        const passwordHash = await bcrypt.hash(body.password, 10);

        const user = await tx.user.create({
          data: {
            societyId: inv.societyId,
            username: body.username.trim(),
            name: body.name.trim(),
            email: body.email.trim(),
            phone: phoneValue,
            passwordHash,
            role: inv.role,
            residentType: "OWNER",
            villaId,
            moveInDate: new Date(),
            isActive: true,
          },
          include: {
            villa: {
              select: {
                id: true,
                villaNumber: true,
                block: true,
              },
            },
            society: {
              select: {
                id: true,
                name: true,
                status: true,
              },
            },
          },
        });

        const invUp = await tx.invitation.updateMany({
          where: { id: inv.id, status: InvitationStatus.PENDING },
          data: {
            status: InvitationStatus.ACCEPTED,
            acceptedAt: new Date(),
          },
        });

        if (invUp.count !== 1) {
          await tx.user.delete({ where: { id: user.id } });
          throw new InviteRegisterError(409, "Invitation already used");
        }

        return user;
      });

      const userResult = result;

      await applyLoginDevice({
        userId: userResult.id,
        fcmToken: body.fcmToken,
        deviceId: body.deviceId,
        deviceType: body.deviceType,
        deviceName: body.deviceName,
      });

      return res.status(201).json(await serializeAuthUser(userResult));
    } catch (error) {
      if (error instanceof InviteRegisterError) {
        res.status(error.statusCode).json({ message: error.message });
        return;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        res.status(409).json({ message: "Username, email, or phone already in use for this society" });
        return;
      }
      next(error);
    }
  },
);

const deviceFieldsSchema = z.object({
  fcmToken: z.string().nullable().optional(),
  deviceId: z.string().nullable().optional(),
  deviceType: z.enum(["ANDROID", "IOS", "WEB"]).nullable().optional(),
  deviceName: z.string().nullable().optional(),
});

const superAdminLoginSchema = z
  .object({
    username: z.string().trim().min(3),
    password: z.string().min(6),
  })
  .merge(deviceFieldsSchema);

/**
 * POST /auth/super-admin/login — platform operator (no society).
 */
router.post("/super-admin/login", loginRateLimiter, validateBody(superAdminLoginSchema), async (req, res, next) => {
  try {
    const { username, password, fcmToken, deviceId, deviceType, deviceName } =
      req.body as z.infer<typeof superAdminLoginSchema>;
    const identifier = username.trim();

    const tKey = throttleKey(null, identifier);
    const lockSeconds = checkLoginThrottle(tKey);
    if (lockSeconds != null) {
      return res.status(429).json({
        message: `Account temporarily locked. Try again in ${lockSeconds} seconds.`,
      });
    }

    let user = await prisma.user.findFirst({
      where: {
        role: UserRole.SUPER_ADMIN,
        ...identifierWhere(identifier),
      },
      include: loginUserInclude,
    });

    // Platform account must be tenant-scoped to no society; fix mis-seeded or hand-edited rows.
    if (user && user.societyId !== null) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { societyId: null },
        include: loginUserInclude,
      });
    }

    if (!user) {
      recordLoginFailure(tKey);
      return res.status(401).json({ message: "Invalid credentials" });
    }
    if (!user.isActive) {
      return res.status(401).json({ message: "Account is inactive" });
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      recordLoginFailure(tKey);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    clearLoginThrottle(tKey);
    await applyLoginDevice({ userId: user.id, fcmToken, deviceId, deviceType, deviceName });
    return res.json(await serializeAuthUser(user));
  } catch (error) {
    next(error);
  }
});

const adminLoginSchema = z
  .object({
    societyId: z.string().min(1),
    username: z.string().trim().min(3),
    password: z.string().min(6),
  })
  .merge(deviceFieldsSchema);

/**
 * POST /auth/admin/login — society admin web dashboard.
 */
router.post("/admin/login", loginRateLimiter, validateBody(adminLoginSchema), async (req, res, next) => {
  try {
    const { societyId, username, password, fcmToken, deviceId, deviceType, deviceName } =
      req.body as z.infer<typeof adminLoginSchema>;
    const identifier = username.trim();

    const tKey = throttleKey(societyId, identifier);
    const lockSeconds = checkLoginThrottle(tKey);
    if (lockSeconds != null) {
      return res.status(429).json({
        message: `Account temporarily locked. Try again in ${lockSeconds} seconds.`,
      });
    }

    const candidates = await prisma.user.findMany({
      where: {
        societyId,
        role: { in: [UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] },
        ...identifierWhere(identifier),
      },
      include: loginUserInclude,
    });

    if (candidates.length === 0) {
      recordLoginFailure(tKey);
      return res.status(401).json({ message: "Invalid credentials" });
    }
    if (candidates.length > 1) {
      return res.status(401).json({
        message:
          "Multiple accounts match this login. Use your username or email (not phone) if more than one admin shares this number.",
      });
    }
    const user = candidates[0];
    if (!user.isActive) {
      return res.status(401).json({ message: "Account is inactive" });
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      recordLoginFailure(tKey);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    clearLoginThrottle(tKey);
    await applyLoginDevice({ userId: user.id, fcmToken, deviceId, deviceType, deviceName });
    return res.json(await serializeAuthUser(user));
  } catch (error) {
    next(error);
  }
});

const tenantLoginSchema = z
  .object({
    societyId: z.string().min(1),
    username: z.string().trim().min(3),
    password: z.string().min(6),
  })
  .merge(deviceFieldsSchema);

/**
 * POST /auth/login — resident/guard mobile (society-scoped).
 */
router.post("/login", loginRateLimiter, validateBody(tenantLoginSchema), async (req, res, next) => {
  try {
    const { societyId, username, password, fcmToken, deviceId, deviceType, deviceName } =
      req.body as z.infer<typeof tenantLoginSchema>;
    const identifier = username.trim();

    const tKey = throttleKey(societyId, identifier);
    const lockSeconds = checkLoginThrottle(tKey);
    if (lockSeconds != null) {
      return res.status(429).json({
        message: `Account temporarily locked. Try again in ${lockSeconds} seconds.`,
      });
    }

    const candidates = await prisma.user.findMany({
      where: {
        societyId,
        role: { in: [UserRole.RESIDENT, UserRole.GUARD, UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] },
        ...identifierWhere(identifier),
      },
      include: loginUserInclude,
    });

    if (candidates.length === 0) {
      recordLoginFailure(tKey);
      return res.status(401).json({ message: "Invalid credentials" });
    }
    if (candidates.length > 1) {
      return res.status(401).json({
        message:
          "Multiple accounts match this login. Sign in with your username or email — this phone is linked to more than one account in this society.",
      });
    }
    const user = candidates[0];
    if (!user.isActive) {
      return res.status(401).json({ message: "Account is inactive" });
    }

    if (user.society?.status === SocietyStatus.INACTIVE) {
      return res.status(403).json({ message: "Society is inactive" });
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      recordLoginFailure(tKey);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    clearLoginThrottle(tKey);
    await applyLoginDevice({ userId: user.id, fcmToken, deviceId, deviceType, deviceName });
    return res.json(await serializeAuthUser(user));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/refresh — exchange a valid refresh token for a new access + refresh token pair.
 * The old refresh token is revoked (rotation).
 */
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

router.post("/refresh", refreshRateLimiter, validateBody(refreshSchema), async (req, res, next) => {
  try {
    const { refreshToken: rawToken } = req.body as z.infer<typeof refreshSchema>;
    const hashed = hashRefreshToken(rawToken);

    const stored = await prisma.refreshToken.findUnique({
      where: { token: hashed },
      include: {
        user: {
          include: loginUserInclude,
        },
      },
    });

    if (!stored || stored.revoked || stored.expiresAt <= new Date()) {
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }

    if (!stored.user.isActive) {
      return res.status(401).json({ message: "Account is inactive" });
    }

    // Revoke old token (rotation)
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked: true },
    });

    // Issue new tokens
    return res.json(await serializeAuthUser(stored.user));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

const requestPasswordResetSchema = z.object({
  email: z.string().email(),
  societyId: z.string().min(1),
});

/**
 * POST /auth/request-password-reset — send a password reset email.
 *
 * Always returns 200 to avoid user enumeration. If the email/society combo
 * doesn't match a user, no email is sent.
 */
router.post(
  "/request-password-reset",
  loginRateLimiter,
  validateBody(requestPasswordResetSchema),
  async (req, res, next) => {
    try {
      const { email, societyId } = req.body as z.infer<typeof requestPasswordResetSchema>;

      // Always respond the same to prevent user enumeration.
      const ok = { message: "If an account with that email exists, a reset link has been sent." };

      const user = await prisma.user.findFirst({
        where: {
          email: { equals: email.trim(), mode: "insensitive" },
          societyId,
          isActive: true,
        },
        select: { id: true, name: true, email: true },
      });

      if (!user) {
        return res.json(ok);
      }

      // Invalidate any previous unused tokens for this user.
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { expiresAt: new Date(0) },
      });

      const rawToken = crypto.randomBytes(32).toString("hex");
      const hashed = crypto.createHash("sha256").update(rawToken).digest("hex");

      await prisma.passwordResetToken.create({
        data: {
          token: hashed,
          userId: user.id,
          expiresAt: new Date(Date.now() + RESET_TOKEN_EXPIRY_MS),
        },
      });

      const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
      const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl,
      });

      return res.json(ok);
    } catch (error) {
      next(error);
    }
  },
);

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

/**
 * POST /auth/reset-password — set a new password using a valid reset token.
 */
router.post(
  "/reset-password",
  validateBody(resetPasswordSchema),
  async (req, res, next) => {
    try {
      const { token: rawToken, password } = req.body as z.infer<typeof resetPasswordSchema>;
      const hashed = crypto.createHash("sha256").update(rawToken).digest("hex");

      const stored = await prisma.passwordResetToken.findUnique({
        where: { token: hashed },
        include: { user: { select: { id: true, isActive: true } } },
      });

      if (!stored || stored.usedAt || stored.expiresAt <= new Date()) {
        return res.status(400).json({ message: "Invalid or expired reset token" });
      }

      if (!stored.user.isActive) {
        return res.status(400).json({ message: "Account is inactive" });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      await prisma.$transaction([
        prisma.user.update({
          where: { id: stored.user.id },
          data: { passwordHash },
        }),
        prisma.passwordResetToken.update({
          where: { id: stored.id },
          data: { usedAt: new Date() },
        }),
        // Revoke all refresh tokens to force re-login on all devices.
        prisma.refreshToken.updateMany({
          where: { userId: stored.user.id, revoked: false },
          data: { revoked: true },
        }),
      ]);

      return res.json({ message: "Password has been reset successfully" });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
