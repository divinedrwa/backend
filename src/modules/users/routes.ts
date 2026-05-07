import { UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
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
    moveInDate: z.string().datetime().optional(),
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
  );

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z
    .preprocess((v) => (v === "" ? null : v), z.string().nullable().optional()),
  /** Admin password reset — omit or empty to leave unchanged */
  password: z.string().min(6).optional().or(z.literal("")),
  villaId: z.string().optional().nullable(),
  residentType: z.enum(["OWNER", "TENANT", "FAMILY_MEMBER"]).optional(),
  moveInDate: z.string().datetime().optional().nullable(),
  moveOutDate: z.string().datetime().optional().nullable(),
  isActive: z.boolean().optional(),
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
        villa: {
          select: {
            villaNumber: true,
            block: true,
          },
        },
        moveInDate: true,
        moveOutDate: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ users });
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

      const user = await prisma.user.create({
        data: {
          societyId,
          username: payload.username,
          name: payload.name,
          email: payload.email,
          phone: payload.phone,
          passwordHash,
          role: payload.role,
          residentType: payload.role === UserRole.RESIDENT && payload.residentType 
            ? payload.residentType 
            : "OWNER",
          villaId:
            payload.role === UserRole.RESIDENT
              ? resolvedVillaId
              : payload.villaId?.trim() || undefined,
          moveInDate: payload.moveInDate ? new Date(payload.moveInDate) : new Date(),
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          villaId: true,
          villa: {
            select: {
              villaNumber: true,
              block: true,
            },
          },
          moveInDate: true,
          isActive: true,
        },
      });
      
      return res.status(201).json({ user });
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
      const body = req.body as z.infer<typeof updateUserSchema>;
      const { password, moveOutDate, moveInDate, email, ...rest } = body;

      const existing = await prisma.user.findFirst({
        where: { id, societyId: req.auth!.societyId },
        select: { id: true, email: true },
      });
      if (!existing) {
        return res.status(404).json({ message: "User not found" });
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

      const data: Record<string, unknown> = { ...rest };
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

      const result = await prisma.user.updateMany({
        where: { id, societyId: req.auth!.societyId },
        data: data as Record<string, unknown>,
      });

      if (result.count === 0) {
        return res.status(404).json({ message: "User not found" });
      }

      const updatedUser = await prisma.user.findUnique({
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
          villa: {
            select: {
              villaNumber: true,
              block: true,
            },
          },
          moveInDate: true,
          moveOutDate: true,
          isActive: true,
        },
      });

      return res.json({ user: updatedUser });
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
