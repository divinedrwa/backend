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
import { prisma } from "../../lib/prisma";
import { validateBody } from "../../middlewares/validate";
import { signAuthToken } from "../../utils/jwt";

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
    console.error("[auth] device token upsert failed", {
      userId,
      deviceId,
      deviceType,
    });
  }
}

const registerWithInvitationSchema = z.object({
  token: z.string().min(16),
  username: z.string().min(3).max(50),
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
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

function serializeAuthUser(user: {
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
  return {
    token,
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

/** Client clears JWT locally; backend is stateless (204). */
router.post("/logout", (_req, res) => {
  res.status(204).send();
});

/**
 * POST /auth/register-with-invitation — public; completes a pending invite.
 */
router.post(
  "/register-with-invitation",
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
        if (inv.role === UserRole.RESIDENT) {
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

      return res.status(201).json(serializeAuthUser(userResult));
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
    username: z.string().min(3),
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
      return res.status(401).json({ message: "Invalid credentials" });
    }
    if (!user.isActive) {
      return res.status(401).json({ message: "Account is inactive" });
    }

    const passwordOk = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    await applyLoginDevice({ userId: user.id, fcmToken, deviceId, deviceType, deviceName });
    return res.json(serializeAuthUser(user));
  } catch (error) {
    next(error);
  }
});

const adminLoginSchema = z
  .object({
    societyId: z.string().min(1),
    username: z.string().min(3),
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

    const candidates = await prisma.user.findMany({
      where: {
        societyId,
        role: UserRole.ADMIN,
        ...identifierWhere(identifier),
      },
      include: loginUserInclude,
    });

    if (candidates.length === 0) {
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

    const passwordOk = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    await applyLoginDevice({ userId: user.id, fcmToken, deviceId, deviceType, deviceName });
    return res.json(serializeAuthUser(user));
  } catch (error) {
    next(error);
  }
});

const tenantLoginSchema = z
  .object({
    societyId: z.string().min(1),
    username: z.string().min(3),
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

    const candidates = await prisma.user.findMany({
      where: {
        societyId,
        role: { in: [UserRole.RESIDENT, UserRole.GUARD, UserRole.ADMIN] },
        ...identifierWhere(identifier),
      },
      include: loginUserInclude,
    });

    if (candidates.length === 0) {
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

    const passwordOk = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    await applyLoginDevice({ userId: user.id, fcmToken, deviceId, deviceType, deviceName });
    return res.json(serializeAuthUser(user));
  } catch (error) {
    next(error);
  }
});

export default router;
