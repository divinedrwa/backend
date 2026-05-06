import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { SocietyStatus, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { signAuthToken } from "../../utils/jwt";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.SUPER_ADMIN));

const createSocietySchema = z.object({
  name: z.string().min(2).max(200),
  address: z.string().max(500).optional(),
});

/**
 * POST /api/super/societies — create a tenant society.
 */
router.post("/societies", validateBody(createSocietySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSocietySchema>;
    const society = await prisma.society.create({
      data: {
        name: body.name.trim(),
        address: body.address?.trim() || null,
        createdByUserId: req.auth!.userId,
      },
      select: { id: true, name: true, address: true, status: true },
    });
    res.status(201).json({ society });
  } catch (e) {
    next(e);
  }
});

const createSocietyAdminSchema = z.object({
  username: z.string().min(3).max(50),
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().min(5).optional(),
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

    res.json({ token, user: adminUser });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/super/societies — list all societies (platform view).
 */
router.get("/societies", async (_req, res, next) => {
  try {
    const rows = await prisma.society.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        address: true,
        status: true,
        createdAt: true,
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
    const societies = rows.map(({ users, ...s }) => ({
      ...s,
      admins: users,
    }));
    res.json({ societies });
  } catch (e) {
    next(e);
  }
});

const updateSocietySchema = z.object({
  name: z.string().min(2).max(200).optional(),
  address: z.union([z.string().max(500), z.null()]).optional(),
  status: z.nativeEnum(SocietyStatus).optional(),
});

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
 * DELETE /api/super/societies/:societyId — permanently remove tenant and all cascade data.
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
      select: { id: true, name: true },
    });
    if (!existing) {
      res.status(404).json({ message: "Society not found" });
      return;
    }

    await prisma.society.delete({ where: { id: societyId } });

    res.status(200).json({
      ok: true,
      deleted: { id: societyId, name: existing.name },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
