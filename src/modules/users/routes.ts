import { MaintenanceBillingRole, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import {
  defaultMaintenanceBillingRoleForNewResident,
  demoteOtherResidentsToExcluded,
  ensurePrimaryCoverageForVilla,
} from "../../lib/maintenanceBillingRole";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { resolveResidentDwelling } from "../../lib/residentUnitResolve";
import { findOrCreateShellVillaForResident } from "../../services/societyProvisioning";

const router = Router();

const createUserSchema = z
  .object({
    username: z.string().min(3).max(50),
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(6),
    phone: z.string().optional(),
    role: z.nativeEnum(UserRole),
    residentType: z.enum(["OWNER", "TENANT", "FAMILY_MEMBER"]).optional(),
    villaId: z.string().optional(),
    /** When set without villaId, matches CSV import: create shell villa in this society if needed */
    villaNumber: z.string().min(1).optional(),
    /** Occupant unit within the property; if omitted, default unit is used. */
    unitId: z.string().optional(),
    moveInDate: z.string().datetime().optional(),
    maintenanceBillingRole: z.nativeEnum(MaintenanceBillingRole).optional(),
  })
  .refine(
    (d) => {
      if (d.role !== UserRole.RESIDENT) return true;
      const hasVid = Boolean(d.villaId?.trim());
      const hasNum = Boolean(d.villaNumber?.trim());
      return hasVid || hasNum;
    },
    { message: "Residents require villaId or villaNumber", path: ["villaNumber"] },
  )
  .refine(
    (d) => {
      if (d.role !== UserRole.RESIDENT) return true;
      const hasVid = Boolean(d.villaId?.trim());
      const hasNum = Boolean(d.villaNumber?.trim());
      return !(hasVid && hasNum);
    },
    { message: "Provide either villaId or villaNumber, not both", path: ["villaNumber"] },
  )
  .refine(
    (d) => d.role === UserRole.RESIDENT || d.maintenanceBillingRole === undefined,
    { message: "maintenanceBillingRole applies only to residents", path: ["maintenanceBillingRole"] },
  );

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z
    .preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
  /** Admin password reset — omit or empty to leave unchanged */
  password: z.string().min(6).optional().or(z.literal("")),
  villaId: z.string().optional().nullable(),
  unitId: z.string().optional().nullable(),
  residentType: z.enum(["OWNER", "TENANT", "FAMILY_MEMBER"]).optional(),
  moveInDate: z.string().datetime().optional().nullable(),
  moveOutDate: z.string().datetime().optional().nullable(),
  isActive: z.boolean().optional(),
  maintenanceBillingRole: z.nativeEnum(MaintenanceBillingRole).optional(),
});

router.use(requireAuth);

// GET /api/users - List all users
router.get("/", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { role, isActive } = req.query;
    
    const where: any = { societyId: req.auth!.societyId };
    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive === "true";

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        societyId: true,
        username: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        residentType: true,
        villaId: true,
        unitId: true,
        villa: {
          select: {
            villaNumber: true,
            block: true,
          },
        },
        unit: {
          select: {
            id: true,
            unitCode: true,
            label: true,
            isDefault: true,
          },
        },
        moveInDate: true,
        moveOutDate: true,
        isActive: true,
        maintenanceBillingRole: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      users: users.map((u) => ({
        ...u,
        linkedPropertyId: u.villaId,
        linkedUnitId: u.unitId,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/users - Create new user
router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createUserSchema),
  async (req, res, next) => {
    try {
      const payload = req.body as z.infer<typeof createUserSchema>;
      const passwordHash = await bcrypt.hash(payload.password, 10);
      
      // Check if username already exists
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { username: payload.username },
            { email: payload.email }
          ]
        }
      });

      if (existingUser) {
        if (existingUser.username === payload.username) {
          return res.status(400).json({ message: "Username already exists" });
        }
        if (existingUser.email === payload.email) {
          return res.status(400).json({ message: "Email already exists" });
        }
      }

      const societyId = req.auth!.societyId;
      let resolvedVillaId: string | undefined =
        payload.villaId?.trim() || undefined;

      if (payload.role === UserRole.RESIDENT) {
        if (payload.villaId?.trim()) {
          const villa = await prisma.villa.findFirst({
            where: { id: payload.villaId, societyId },
          });
          if (!villa) {
            return res.status(400).json({ message: "Villa not found in this society" });
          }
          resolvedVillaId = villa.id;
        } else if (payload.villaNumber?.trim()) {
          const shell = await findOrCreateShellVillaForResident({
            societyId,
            displayVillaNumber: payload.villaNumber.trim(),
            placeholderOwnerName: payload.name,
          });
          if (!shell.ok) {
            return res.status(400).json({ message: shell.message });
          }
          resolvedVillaId = shell.villaId;
        }
      }

      let resolvedDwelling: { villaId: string; unitId: string } | null = null;
      if (payload.role === UserRole.RESIDENT && resolvedVillaId) {
        resolvedDwelling = await resolveResidentDwelling(prisma, {
          societyId,
          villaId: resolvedVillaId,
          unitId: payload.unitId ?? null,
        });
        if (!resolvedDwelling) {
          return res.status(400).json({ message: "Invalid or unknown unit for this property" });
        }
        resolvedVillaId = resolvedDwelling.villaId;
      }

      let billingRole: MaintenanceBillingRole | undefined;
      if (payload.role === UserRole.RESIDENT && resolvedVillaId) {
        billingRole =
          payload.maintenanceBillingRole ??
          (await defaultMaintenanceBillingRoleForNewResident({
            societyId,
            villaId: resolvedVillaId,
          }));
        if (billingRole === MaintenanceBillingRole.EXCLUDED) {
          const otherActive = await prisma.user.count({
            where: {
              societyId,
              villaId: resolvedVillaId,
              role: UserRole.RESIDENT,
              isActive: true,
            },
          });
          if (otherActive < 1) {
            return res.status(400).json({
              message:
                "Cannot add resident as excluded: there must already be another active resident on this villa who pays maintenance.",
            });
          }
        }
      }

      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            societyId,
            username: payload.username,
            name: payload.name,
            email: payload.email,
            phone: payload.phone,
            passwordHash,
            role: payload.role,
            residentType:
              payload.role === UserRole.RESIDENT && payload.residentType
                ? payload.residentType
                : "OWNER",
            villaId:
              payload.role === UserRole.RESIDENT
                ? resolvedVillaId
                : payload.villaId?.trim() || undefined,
            unitId:
              payload.role === UserRole.RESIDENT && resolvedDwelling
                ? resolvedDwelling.unitId
                : undefined,
            moveInDate: payload.moveInDate ? new Date(payload.moveInDate) : new Date(),
            isActive: true,
            ...(payload.role === UserRole.RESIDENT && resolvedVillaId && billingRole
              ? { maintenanceBillingRole: billingRole }
              : {}),
          },
          select: { id: true, societyId: true, villaId: true, role: true },
        });

        if (
          created.role === UserRole.RESIDENT &&
          created.villaId &&
          billingRole === MaintenanceBillingRole.PRIMARY
        ) {
          await demoteOtherResidentsToExcluded(tx, {
            societyId,
            villaId: created.villaId,
            primaryUserId: created.id,
          });
        }
        if (created.role === UserRole.RESIDENT && created.villaId) {
          await ensurePrimaryCoverageForVilla(tx, {
            societyId,
            villaId: created.villaId,
          });
        }

        return tx.user.findUniqueOrThrow({
          where: { id: created.id },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            villaId: true,
            unitId: true,
            maintenanceBillingRole: true,
            villa: {
              select: {
                villaNumber: true,
                block: true,
              },
            },
            unit: {
              select: { id: true, unitCode: true, label: true, isDefault: true },
            },
            moveInDate: true,
            isActive: true,
          },
        });
      });

      const u = user;
      return res.status(201).json({
        user: {
          ...u,
          linkedPropertyId: u.villaId,
          linkedUnitId: u.unitId,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /api/users/:id - Update user
router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateUserSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const societyId = req.auth!.societyId;
      const body = req.body as z.infer<typeof updateUserSchema>;
      const {
        password,
        moveOutDate,
        moveInDate,
        email,
        maintenanceBillingRole,
        villaId: bodyVillaId,
        unitId: bodyUnitId,
        ...rest
      } = body;

      const existing = await prisma.user.findFirst({
        where: { id, societyId },
        select: {
          id: true,
          email: true,
          role: true,
          villaId: true,
          unitId: true,
          isActive: true,
          maintenanceBillingRole: true,
        },
      });
      if (!existing) {
        return res.status(404).json({ message: "User not found" });
      }

      if (maintenanceBillingRole !== undefined && existing.role !== UserRole.RESIDENT) {
        return res.status(400).json({ message: "maintenanceBillingRole applies only to residents" });
      }

      if (email !== undefined && email !== existing.email) {
        const emailTaken = await prisma.user.findFirst({
          where: { email, NOT: { id } },
          select: { id: true },
        });
        if (emailTaken) {
          return res.status(400).json({ message: "Email already in use" });
        }
      }

      const nextVillaId =
        bodyVillaId !== undefined ? bodyVillaId : existing.villaId;
      const nextBillingRole =
        maintenanceBillingRole !== undefined
          ? maintenanceBillingRole
          : existing.maintenanceBillingRole;

      const villaAssignmentChanged =
        bodyVillaId !== undefined && bodyVillaId !== existing.villaId;
      const switchingToExcluded =
        maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED &&
        existing.maintenanceBillingRole !== MaintenanceBillingRole.EXCLUDED;

      if (
        nextBillingRole === MaintenanceBillingRole.EXCLUDED &&
        existing.role === UserRole.RESIDENT &&
        (switchingToExcluded || villaAssignmentChanged)
      ) {
        if (!nextVillaId) {
          return res.status(400).json({ message: "Resident must have a villa to set billing role" });
        }
        const otherActive = await prisma.user.count({
          where: {
            societyId,
            villaId: nextVillaId,
            role: UserRole.RESIDENT,
            isActive: true,
            NOT: { id },
          },
        });
        if (otherActive < 1) {
          return res.status(400).json({
            message:
              "To mark this resident as excluded, there must already be another active resident on the same villa who can be the maintenance payer. Add or activate that account first (or pick a different villa).",
          });
        }
      }

      let dwellingOverride: { villaId: string; unitId: string } | null = null;
      if (
        existing.role === UserRole.RESIDENT &&
        (bodyVillaId !== undefined || bodyUnitId !== undefined)
      ) {
        dwellingOverride = await resolveResidentDwelling(prisma, {
          societyId,
          villaId: bodyVillaId !== undefined ? bodyVillaId : existing.villaId,
          unitId:
            bodyUnitId !== undefined
              ? bodyUnitId
              : bodyVillaId !== undefined
                ? null
                : existing.unitId,
        });
        if (!dwellingOverride) {
          return res.status(400).json({ message: "Invalid property/unit assignment" });
        }
      }

      const data: Record<string, unknown> = { ...rest };
      if (dwellingOverride) {
        data.villaId = dwellingOverride.villaId;
        data.unitId = dwellingOverride.unitId;
      }
      if (email !== undefined) {
        data.email = email;
      }
      if (moveInDate !== undefined) {
        data.moveInDate = moveInDate ? new Date(moveInDate) : null;
      }
      if (password && String(password).length >= 6) {
        data.passwordHash = await bcrypt.hash(String(password), 10);
      }
      if (moveOutDate !== undefined) {
        data.moveOutDate = moveOutDate ? new Date(moveOutDate) : null;
        if (moveOutDate) {
          data.isActive = false;
        }
      }
      if (maintenanceBillingRole !== undefined) {
        data.maintenanceBillingRole = maintenanceBillingRole;
      }

      const oldVillaId = existing.villaId;

      const updatedUser = await prisma.$transaction(async (tx) => {
        const result = await tx.user.updateMany({
          where: { id, societyId },
          data: data as Record<string, unknown>,
        });

        if (result.count === 0) {
          return null;
        }

        const after = await tx.user.findUnique({
          where: { id },
          select: {
            role: true,
            villaId: true,
            isActive: true,
            maintenanceBillingRole: true,
            societyId: true,
          },
        });

        const afterVillaId = after?.villaId ?? null;
        if (after?.role === UserRole.RESIDENT && afterVillaId && after.isActive) {
          if (after.maintenanceBillingRole === MaintenanceBillingRole.PRIMARY) {
            await demoteOtherResidentsToExcluded(tx, {
              societyId,
              villaId: afterVillaId,
              primaryUserId: id,
            });
          }
        }

        const newVillaId = afterVillaId;
        if (oldVillaId && oldVillaId !== newVillaId) {
          await ensurePrimaryCoverageForVilla(tx, { societyId, villaId: oldVillaId });
        }
        if (newVillaId) {
          await ensurePrimaryCoverageForVilla(tx, { societyId, villaId: newVillaId });
        }

        return tx.user.findUnique({
          where: { id },
          select: {
            id: true,
            username: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            residentType: true,
            villaId: true,
            unitId: true,
            maintenanceBillingRole: true,
            villa: {
              select: {
                villaNumber: true,
                block: true,
              },
            },
            unit: {
              select: { id: true, unitCode: true, label: true, isDefault: true },
            },
            moveInDate: true,
            moveOutDate: true,
            isActive: true,
          },
        });
      });

      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }

      return res.json({
        user: {
          ...updatedUser,
          linkedPropertyId: updatedUser.villaId,
          linkedUnitId: updatedUser.unitId,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/users/:id - Delete user
router.delete("/:id", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    await prisma.user.deleteMany({
      where: { id, societyId: req.auth!.societyId },
    });

    return res.json({ message: "User deleted" });
  } catch (error) {
    next(error);
  }
});

export default router;
