import { Router } from "express";
import { z } from "zod";
import { NotificationCategory, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifySocietyRoles } from "../../services/notification.service";
import { logger } from "../../lib/logger";

const router = Router();

router.use(requireAuth);

const createRequestSchema = z.object({
  gateId: z.string().min(1),
  requestType: z.enum(["TURN_ON", "TURN_OFF"]),
  reason: z.string().trim().min(3).max(200),
});

// POST /api/residents/water-requests - Submit a water supply request
router.post(
  "/water-requests",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  validateBody(createRequestSchema),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { gateId, requestType, reason } = req.body as z.infer<typeof createRequestSchema>;

      // Verify gate belongs to society
      const gate = await prisma.gate.findFirst({
        where: { id: gateId, societyId, isActive: true },
      });
      if (!gate) {
        return res.status(404).json({ message: "Gate not found" });
      }

      // Prevent duplicate pending requests per user + gate
      const existing = await prisma.waterSupplyRequest.findFirst({
        where: { userId, gateId, status: "PENDING" },
      });
      if (existing) {
        return res.status(409).json({
          message: "You already have a pending request for this gate",
        });
      }

      const request = await prisma.waterSupplyRequest.create({
        data: {
          societyId,
          userId,
          gateId,
          requestType,
          reason,
        },
        include: {
          gate: { select: { name: true } },
          user: { select: { name: true } },
        },
      });

      // Notify guards and admins
      void notifySocietyRoles({
        societyId,
        roles: [UserRole.GUARD, UserRole.ADMIN],
        category: NotificationCategory.WATER_SUPPLY,
        title: `Water ${requestType === "TURN_ON" ? "ON" : "OFF"} Request`,
        body: `${request.user.name} requested water ${requestType === "TURN_ON" ? "ON" : "OFF"} at ${request.gate.name}: ${reason}`,
        data: {
          type: "WATER_SUPPLY_REQUEST",
          requestId: request.id,
          gateId,
          requestType,
        },
      }).catch((err) =>
        logger.error({ err }, "[notifications] water request push failed")
      );

      return res.status(201).json({
        message: "Water supply request submitted",
        request,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/residents/water-requests - List my water requests
router.get(
  "/water-requests",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;

      const requests = await prisma.waterSupplyRequest.findMany({
        where: { userId, societyId },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          gate: { select: { name: true } },
          resolvedBy: { select: { name: true } },
        },
      });

      return res.json({ requests });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
