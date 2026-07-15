import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import {
  BillingCycleStatus,
  BillingPaymentSource,
  BillingUserPaymentStatus,
  Prisma,
  PushPlatform,
  SocietyStatus,
  SocietySubscriptionPlan,
  SocietySubscriptionStatus,
  UserRole,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole, invalidateAuthCacheForSociety } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { signAuthToken } from "../../utils/jwt";
import { passwordSchema } from "../../lib/passwordSchema";
import { auditFromRequest } from "../../services/audit.service";
import { compareSemver } from "../../lib/semver";
import { computeOnboardingStatus } from "../../lib/societyOnboarding";
import { aggregatePlatformRevenue } from "../../lib/platformRevenue";
import { societyIsSandboxColumnExists } from "../../lib/sandboxSociety";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.SUPER_ADMIN));

const createSocietySchema = z.object({
  name: z.string().trim().min(2).max(200),
  address: z.string().trim().max(500).optional(),
  isSandbox: z.boolean().optional(),
});

function parseSocietySearch(req: { query: Record<string, unknown> }): string | undefined {
  const raw = typeof req.query.search === "string" ? req.query.search : "";
  const q = raw.trim();
  return q.length > 0 ? q : undefined;
}

/**
 * POST /api/super/societies — create a tenant society.
 */
router.post("/societies", validateBody(createSocietySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSocietySchema>;
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    const society = await prisma.$transaction(async (tx) => {
      const hasSandboxFlag = await societyIsSandboxColumnExists();
      const created = await tx.society.create({
        data: {
          name: body.name.trim(),
          address: body.address?.trim() || null,
          createdByUserId: req.auth!.userId,
          ...(hasSandboxFlag && body.isSandbox === true ? { isSandbox: true } : {}),
        },
        select: {
          id: true,
          name: true,
          address: true,
          status: true,
          ...(hasSandboxFlag ? { isSandbox: true } : {}),
        },
      });
      await tx.societySubscription.create({
        data: {
          societyId: created.id,
          plan: SocietySubscriptionPlan.TRIAL,
          status: SocietySubscriptionStatus.TRIAL,
          trialEndsAt,
        },
      });
      return created;
    });
    auditFromRequest(req, {
      adminId: req.auth!.userId,
      action: "CREATE_SOCIETY",
      entityType: "Society",
      entityId: society.id,
      metadata: { name: society.name },
    });
    res.status(201).json({ society });
  } catch (e) {
    next(e);
  }
});

const createSocietyAdminSchema = z.object({
  username: z.string().trim().min(3).max(50),
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  password: passwordSchema,
  phone: z.string().trim().min(5).optional(),
});

/**
 * POST /api/super/societies/:societyId/admins — first admin user for a society.
 */
router.post(
  "/societies/:societyId/admins",
  validateBody(createSocietyAdminSchema),
  async (req, res, next) => {
    try {
      const societyId = req.params.societyId?.trim();
      if (!societyId) {
        res.status(400).json({ message: "Missing society id" });
        return;
      }

      const society = await prisma.society.findUnique({
        where: { id: societyId },
        select: { id: true },
      });
      if (!society) {
        res.status(404).json({ message: "Society not found" });
        return;
      }

      const body = req.body as z.infer<typeof createSocietyAdminSchema>;
      const passwordHash = await bcrypt.hash(body.password, 10);

      const user = await prisma.user.create({
        data: {
          societyId,
          username: body.username.trim(),
          name: body.name.trim(),
          email: body.email.trim().toLowerCase(),
          phone: body.phone?.trim() || null,
          passwordHash,
          role: UserRole.ADMIN,
          isActive: true,
        },
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          societyId: true,
          isActive: true,
          createdAt: true,
        },
      });

      res.status(201).json({ user });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * POST /api/super/societies/:societyId/tenant-session — mint a society-admin JWT so the platform
 * operator can use the normal Society Admin API as that tenant (first active ADMIN user).
 */
router.post("/societies/:societyId/tenant-session", async (req, res, next) => {
  try {
    const societyId = req.params.societyId?.trim();
    if (!societyId) {
      res.status(400).json({ message: "Missing society id" });
      return;
    }

    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: { id: true },
    });
    if (!society) {
      res.status(404).json({ message: "Society not found" });
      return;
    }

    const adminUser = await prisma.user.findFirst({
      where: { societyId, role: UserRole.ADMIN, isActive: true },
      orderBy: { createdAt: "asc" },
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

    if (!adminUser || !adminUser.societyId) {
      res.status(400).json({
        message:
          "No active society admin user found. Create one under “Create society admin” first.",
      });
      return;
    }

    const token = signAuthToken({
      userId: adminUser.id,
      role: UserRole.ADMIN,
      societyId: adminUser.societyId,
      villaId: adminUser.villaId,
    });

    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId,
      action: "IMPERSONATE_TENANT",
      entityType: "Society",
      entityId: societyId,
      metadata: {
        impersonatedUserId: adminUser.id,
        impersonatedUsername: adminUser.username,
      },
    });

    res.json({ token, user: adminUser });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/super/platform-revenue — aggregate platform fees from gateway payments.
 */
router.get("/platform-revenue", async (_req, res, next) => {
  try {
    const revenue = await aggregatePlatformRevenue();
    res.json(revenue);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/super/societies — list all societies (platform view).
 *
 * Includes archived societies so the operator can restore them. The list is
 * sorted by name; clients should rely on `archivedAt` to filter/sort.
 */
router.get("/societies", async (req, res, next) => {
  try {
    const search = parseSocietySearch(req);
    const where: Prisma.SocietyWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { address: { contains: search, mode: "insensitive" } },
          ],
        }
      : {};

    const rows = await prisma.society.findMany({
      where,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        address: true,
        status: true,
        archivedAt: true,
        archivedBy: true,
        createdAt: true,
        subscription: {
          select: {
            plan: true,
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            monthlyAmount: true,
          },
        },
        _count: {
          select: {
            villas: true,
            billingCycles: true,
          },
        },
        billingCycles: {
          where: { status: BillingCycleStatus.OPEN },
          select: { id: true },
          take: 1,
        },
        users: {
          where: { role: UserRole.ADMIN, isActive: true },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            username: true,
            email: true,
            name: true,
          },
        },
      },
    });

    const societyIds = rows.map((r) => r.id);
    const cyclesWithPayments = societyIds.length
      ? await prisma.billingCycle.findMany({
          where: {
            societyId: { in: societyIds },
            payments: {
              some: {
                paymentStatus: BillingUserPaymentStatus.SUCCESS,
                source: BillingPaymentSource.GATEWAY,
              },
            },
          },
          select: { societyId: true },
          distinct: ["societyId"],
        })
      : [];
    const societiesWithGatewayPayments = new Set(cyclesWithPayments.map((c) => c.societyId));

    const societies = rows.map(({ users, subscription, _count, billingCycles, ...s }) => ({
      ...s,
      admins: users,
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            trialEndsAt: subscription.trialEndsAt,
            currentPeriodEnd: subscription.currentPeriodEnd,
            monthlyAmount:
              subscription.monthlyAmount != null ? Number(subscription.monthlyAmount) : null,
          }
        : null,
      onboardingStatus: computeOnboardingStatus({
        archivedAt: s.archivedAt,
        villaCount: _count.villas,
        billingCycleCount: _count.billingCycles,
        openBillingCycleCount: billingCycles.length,
        gatewayPaymentCount: societiesWithGatewayPayments.has(s.id) ? 1 : 0,
      }),
    }));

    res.json({ societies });
  } catch (e) {
    next(e);
  }
});

const updateSocietySchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  address: z.union([z.string().trim().max(500), z.null()]).optional(),
  status: z.nativeEnum(SocietyStatus).optional(),
});

const updateSubscriptionSchema = z.object({
  plan: z.nativeEnum(SocietySubscriptionPlan).optional(),
  status: z.nativeEnum(SocietySubscriptionStatus).optional(),
  trialEndsAt: z.union([z.string().datetime(), z.null()]).optional(),
  currentPeriodEnd: z.union([z.string().datetime(), z.null()]).optional(),
  monthlyAmount: z.union([z.number().min(0), z.null()]).optional(),
  notes: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

/**
 * GET /api/super/societies/:societyId/subscription
 */
router.get("/societies/:societyId/subscription", async (req, res, next) => {
  try {
    const societyId = req.params.societyId?.trim();
    if (!societyId) {
      res.status(400).json({ message: "Missing society id" });
      return;
    }

    const subscription = await prisma.societySubscription.findUnique({
      where: { societyId },
    });
    if (!subscription) {
      res.status(404).json({ message: "Subscription not found" });
      return;
    }

    res.json({
      subscription: {
        ...subscription,
        monthlyAmount:
          subscription.monthlyAmount != null ? Number(subscription.monthlyAmount) : null,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/super/societies/:societyId/subscription
 */
router.patch(
  "/societies/:societyId/subscription",
  validateBody(updateSubscriptionSchema),
  async (req, res, next) => {
    try {
      const societyId = req.params.societyId?.trim();
      if (!societyId) {
        res.status(400).json({ message: "Missing society id" });
        return;
      }

      const body = req.body as z.infer<typeof updateSubscriptionSchema>;
      const existing = await prisma.societySubscription.findUnique({
        where: { societyId },
        select: { id: true },
      });
      if (!existing) {
        res.status(404).json({ message: "Subscription not found" });
        return;
      }

      const data: Prisma.SocietySubscriptionUpdateInput = {};
      if (body.plan !== undefined) data.plan = body.plan;
      if (body.status !== undefined) data.status = body.status;
      if (body.trialEndsAt !== undefined) {
        data.trialEndsAt = body.trialEndsAt ? new Date(body.trialEndsAt) : null;
      }
      if (body.currentPeriodEnd !== undefined) {
        data.currentPeriodEnd = body.currentPeriodEnd ? new Date(body.currentPeriodEnd) : null;
      }
      if (body.monthlyAmount !== undefined) {
        data.monthlyAmount = body.monthlyAmount;
      }
      if (body.notes !== undefined) data.notes = body.notes;

      if (Object.keys(data).length === 0) {
        res.status(400).json({ message: "No fields to update" });
        return;
      }

      const subscription = await prisma.societySubscription.update({
        where: { societyId },
        data,
      });

      await invalidateAuthCacheForSociety(societyId);

      res.json({
        subscription: {
          ...subscription,
          monthlyAmount:
            subscription.monthlyAmount != null ? Number(subscription.monthlyAmount) : null,
        },
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * GET /api/super/societies/:societyId — single society + aggregate counts.
 */
router.get("/societies/:societyId", async (req, res, next) => {
  try {
    const societyId = req.params.societyId?.trim();
    if (!societyId) {
      res.status(400).json({ message: "Missing society id" });
      return;
    }

    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: {
        id: true,
        name: true,
        address: true,
        status: true,
        archivedAt: true,
        archivedBy: true,
        createdAt: true,
        updatedAt: true,
        createdByUserId: true,
        _count: {
          select: {
            users: true,
            villas: true,
            gates: true,
          },
        },
      },
    });

    if (!society) {
      res.status(404).json({ message: "Society not found" });
      return;
    }

    const { _count, ...rest } = society;
    res.json({
      society: {
        ...rest,
        counts: _count,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/super/societies/:societyId — update name, address, lifecycle status.
 */
router.patch(
  "/societies/:societyId",
  validateBody(updateSocietySchema),
  async (req, res, next) => {
    try {
      const societyId = req.params.societyId?.trim();
      if (!societyId) {
        res.status(400).json({ message: "Missing society id" });
        return;
      }

      const body = req.body as z.infer<typeof updateSocietySchema>;
      const existing = await prisma.society.findUnique({
        where: { id: societyId },
        select: { id: true },
      });
      if (!existing) {
        res.status(404).json({ message: "Society not found" });
        return;
      }

      const data: { name?: string; address?: string | null; status?: SocietyStatus } = {};
      if (body.name !== undefined) data.name = body.name.trim();
      if (body.address !== undefined) data.address = body.address?.trim() || null;
      if (body.status !== undefined) data.status = body.status;

      if (Object.keys(data).length === 0) {
        res.status(400).json({ message: "No fields to update" });
        return;
      }

      const society = await prisma.society.update({
        where: { id: societyId },
        data,
        select: { id: true, name: true, address: true, status: true, createdAt: true, updatedAt: true },
      });

      res.json({ society });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * DELETE /api/super/societies/:societyId — soft-archive a tenant.
 *
 * Default behavior: sets `archivedAt = now()`, `archivedBy = SUPER_ADMIN
 * userId`, and forces `status = INACTIVE` so the existing tenant-auth path
 * blocks all sign-ins. Reversible via POST /restore.
 *
 * Hard delete (cascade-permanent): pass `?confirmHardDelete=<societyName>`
 * with the exact case-insensitive name. The typed-name match is the
 * defense against an "Are you sure?" → click-yes accident on the wrong row;
 * it does NOT replace `verify:migrations-safe` or backups.
 */
router.delete("/societies/:societyId", async (req, res, next) => {
  try {
    const societyId = req.params.societyId?.trim();
    if (!societyId) {
      res.status(400).json({ message: "Missing society id" });
      return;
    }

    const existing = await prisma.society.findUnique({
      where: { id: societyId },
      select: { id: true, name: true, archivedAt: true },
    });
    if (!existing) {
      res.status(404).json({ message: "Society not found" });
      return;
    }

    const confirmHardDelete = (
      typeof req.query.confirmHardDelete === "string" ? req.query.confirmHardDelete : ""
    ).trim();

    if (confirmHardDelete) {
      // Strict: the typed name must match (case-insensitive, post-trim).
      // Reject mismatches with 400 — never silently downgrade to soft
      // archive, otherwise a typo on a destructive button would still feel
      // "successful" while doing the wrong thing.
      if (confirmHardDelete.toLowerCase() !== existing.name.toLowerCase()) {
        res.status(400).json({
          message:
            "confirmHardDelete must equal the society name exactly (case-insensitive).",
        });
        return;
      }
      await prisma.society.delete({ where: { id: societyId } });
      await invalidateAuthCacheForSociety(societyId);
      auditFromRequest(req, {
        adminId: req.auth!.userId,
        action: "HARD_DELETE_SOCIETY",
        entityType: "Society",
        entityId: societyId,
        metadata: { name: existing.name },
      });
      res.status(200).json({
        ok: true,
        mode: "hard_deleted",
        society: { id: societyId, name: existing.name },
      });
      return;
    }

    // Soft archive (default).
    if (existing.archivedAt) {
      res.status(200).json({
        ok: true,
        mode: "already_archived",
        society: { id: societyId, name: existing.name, archivedAt: existing.archivedAt },
      });
      return;
    }
    const updated = await prisma.society.update({
      where: { id: societyId },
      data: {
        archivedAt: new Date(),
        archivedBy: req.auth!.userId,
        status: SocietyStatus.INACTIVE,
      },
      select: { id: true, name: true, archivedAt: true, archivedBy: true, status: true },
    });
    await invalidateAuthCacheForSociety(societyId);
    auditFromRequest(req, {
      adminId: req.auth!.userId,
      action: "ARCHIVE_SOCIETY",
      entityType: "Society",
      entityId: societyId,
      metadata: { name: existing.name },
    });
    res.status(200).json({
      ok: true,
      mode: "archived",
      society: updated,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/super/societies/:societyId/restore — reverse a soft-archive.
 *
 * Status is intentionally left INACTIVE: restoring brings the row back into
 * the platform's active surface, but the operator must still flip it to
 * ACTIVE via PATCH if they want tenants to log in. This is by design — a
 * one-click "restore" should not also re-open access.
 */
router.post("/societies/:societyId/restore", async (req, res, next) => {
  try {
    const societyId = req.params.societyId?.trim();
    if (!societyId) {
      res.status(400).json({ message: "Missing society id" });
      return;
    }

    const existing = await prisma.society.findUnique({
      where: { id: societyId },
      select: { id: true, name: true, archivedAt: true },
    });
    if (!existing) {
      res.status(404).json({ message: "Society not found" });
      return;
    }
    if (!existing.archivedAt) {
      res.status(400).json({ message: "Society is not archived" });
      return;
    }

    const society = await prisma.society.update({
      where: { id: societyId },
      data: {
        archivedAt: null,
        archivedBy: null,
      },
      select: {
        id: true,
        name: true,
        status: true,
        archivedAt: true,
      },
    });
    await invalidateAuthCacheForSociety(societyId);
    auditFromRequest(req, {
      adminId: req.auth!.userId,
      action: "RESTORE_SOCIETY",
      entityType: "Society",
      entityId: societyId,
      metadata: { name: existing.name },
    });
    res.json({ ok: true, society });
  } catch (e) {
    next(e);
  }
});

// ── App Version Config ─────────────────────────────────────────────

const semverRegex = /^\d+\.\d+\.\d+$/;

const appVersionSchema = z
  .object({
    platform: z.nativeEnum(PushPlatform),
    latestVersion: z.string().trim().regex(semverRegex, "Must be semver (e.g. 1.2.3)"),
    minVersion: z.string().trim().regex(semverRegex, "Must be semver (e.g. 1.0.0)"),
    storeUrl: z.string().trim().url().nullish(),
    releaseNotes: z.string().trim().max(2000).nullish(),
  })
  .refine((d) => compareSemver(d.minVersion, d.latestVersion) <= 0, {
    message: "minVersion must be <= latestVersion",
    path: ["minVersion"],
  });

/**
 * PUT /api/super/app-version — upsert version config for a platform.
 */
router.put("/app-version", validateBody(appVersionSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof appVersionSchema>;
    const config = await prisma.appVersionConfig.upsert({
      where: { platform: body.platform },
      create: {
        platform: body.platform,
        latestVersion: body.latestVersion,
        minVersion: body.minVersion,
        storeUrl: body.storeUrl ?? null,
        releaseNotes: body.releaseNotes ?? null,
        updatedBy: req.auth!.userId,
      },
      update: {
        latestVersion: body.latestVersion,
        minVersion: body.minVersion,
        storeUrl: body.storeUrl ?? null,
        releaseNotes: body.releaseNotes ?? null,
        updatedBy: req.auth!.userId,
      },
    });
    auditFromRequest(req, {
      adminId: req.auth!.userId,
      action: "UPSERT_APP_VERSION_CONFIG",
      entityType: "AppVersionConfig",
      entityId: config.id,
      metadata: {
        platform: body.platform,
        latestVersion: body.latestVersion,
        minVersion: body.minVersion,
      },
    });
    res.json({ config });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/super/app-version — list all platform version configs.
 */
router.get("/app-version", async (_req, res, next) => {
  try {
    const configs = await prisma.appVersionConfig.findMany({
      orderBy: { platform: "asc" },
    });
    res.json({ configs });
  } catch (e) {
    next(e);
  }
});

export default router;
