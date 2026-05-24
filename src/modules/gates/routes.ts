import { UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createGateSchema = z.object({
  name: z.string().min(2).max(100),
  location: z.string().optional(),
  description: z.string().optional()
});

const updateGateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional()
});

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = { societyId: req.auth!.societyId };
    const [gates, total] = await Promise.all([
      prisma.gate.findMany({
        where,
        orderBy: { name: "asc" },
        include: {
          assignedGuard: {
            select: {
              id: true,
              name: true,
              phone: true
            }
          }
        },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.gate.count({ where }),
    ]);
    return res.json({ gates, ...paginationMeta(total, gates.length, pagination) });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createGateSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createGateSchema>;
      const gate = await prisma.gate.create({
        data: {
          societyId: req.auth!.societyId,
          name: body.name,
          location: body.location,
          description: body.description
        }
      });
      return res.status(201).json({ gate });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateGateSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateGateSchema>;
      const { id } = req.params;

      const gate = await prisma.gate.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: body
      });

      if (gate.count === 0) {
        return res.status(404).json({ message: "Gate not found" });
      }

      return res.json({ message: "Gate updated" });
    } catch (error) {
      next(error);
    }
  }
);

// Assign guard to gate (admin only) - NEW
const assignGuardSchema = z.object({
  guardId: z.string().cuid().optional().nullable()
});

router.patch(
  "/:id/assign-guard",
  requireRole(UserRole.ADMIN),
  validateBody(assignGuardSchema),
  async (req, res, next) => {
    try {
      const { guardId } = req.body as z.infer<typeof assignGuardSchema>;
      const { id } = req.params;

      // If assigning a guard, verify the user is a guard
      if (guardId) {
        const guard = await prisma.user.findFirst({
          where: {
            id: guardId,
            societyId: req.auth!.societyId,
            role: UserRole.GUARD,
            isActive: true
          }
        });

        if (!guard) {
          return res.status(404).json({ message: "Guard not found or inactive" });
        }

        // Check if guard is already assigned to another gate
        const existingAssignment = await prisma.gate.findFirst({
          where: {
            societyId: req.auth!.societyId,
            assignedGuardId: guardId,
            id: { not: id }
          }
        });

        if (existingAssignment) {
          return res.status(400).json({ 
            message: "Guard is already assigned to another gate",
            assignedGate: existingAssignment.name
          });
        }
      }

      const gate = await prisma.gate.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: { assignedGuardId: guardId }
      });

      if (gate.count === 0) {
        return res.status(404).json({ message: "Gate not found" });
      }

      return res.json({ message: guardId ? "Guard assigned to gate" : "Guard unassigned from gate" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
