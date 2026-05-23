import { PatrolStatus, Prisma, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createPatrolSchema = z.object({
  gateId: z.string().cuid(),
  checkpointName: z.string().min(2),
  checkpointLocation: z.string().optional(),
  scheduledTime: z.string().datetime(),
  notes: z.string().optional()
});

const updatePatrolStatusSchema = z.object({
  status: z.nativeEnum(PatrolStatus),
  actualTime: z.string().datetime().optional(),
  notes: z.string().optional()
});

router.use(requireAuth);

// List all patrols (admin)
router.get("/", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = { societyId: req.auth!.societyId };
    const [patrols, total] = await Promise.all([
      prisma.guardPatrol.findMany({
        where,
        include: {
          guard: { select: { id: true, name: true } },
          gate: { select: { id: true, name: true } },
        },
        orderBy: { scheduledTime: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.guardPatrol.count({ where }),
    ]);
    return res.json({ patrols, ...paginationMeta(total, patrols.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// My patrols (for guards)
router.get("/my-patrols", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = { societyId: req.auth!.societyId, guardId: req.auth!.userId };
    const [patrols, total] = await Promise.all([
      prisma.guardPatrol.findMany({
        where,
        include: { gate: { select: { id: true, name: true, location: true } } },
        orderBy: { scheduledTime: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.guardPatrol.count({ where }),
    ]);
    return res.json({ patrols, ...paginationMeta(total, patrols.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// Create patrol checkpoint (admin)
router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createPatrolSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createPatrolSchema>;

      // For now, assign to the requesting admin or leave empty
      // In real scenario, you'd assign to a specific guard
      const patrol = await prisma.guardPatrol.create({
        data: {
          societyId: req.auth!.societyId,
          guardId: req.auth!.userId, // Temporary - should be specific guard
          gateId: body.gateId,
          checkpointName: body.checkpointName,
          checkpointLocation: body.checkpointLocation,
          scheduledTime: new Date(body.scheduledTime),
          notes: body.notes
        }
      });

      return res.status(201).json({ patrol });
    } catch (error) {
      next(error);
    }
  }
);

// Update patrol status (guard marks checkpoint as complete)
router.patch(
  "/:id/status",
  requireRole(UserRole.GUARD, UserRole.ADMIN),
  validateBody(updatePatrolStatusSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updatePatrolStatusSchema>;
      const { id } = req.params;

      const updateData: Prisma.GuardPatrolUpdateManyMutationInput = {
        status: body.status
      };

      if (body.actualTime) {
        updateData.actualTime = new Date(body.actualTime);
      }
      if (body.notes !== undefined) {
        updateData.notes = body.notes;
      }

      const patrol = await prisma.guardPatrol.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: updateData
      });

      if (patrol.count === 0) {
        return res.status(404).json({ message: "Patrol checkpoint not found" });
      }

      return res.json({ message: "Patrol status updated" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
