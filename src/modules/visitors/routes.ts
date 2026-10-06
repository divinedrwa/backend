import { NotificationCategory, Prisma, UserRole, VisitorStatus, VisitorType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { getOrCreateDefaultUnitIdForVilla } from "../../lib/propertyInfrastructure";
import { occupiedFloorsOfVilla } from "../guards/visitFlatTargets";
import { prisma } from "../../lib/prisma";
import { localDayRange } from "../../lib/societyTime";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import {
  transitionVisitorState,
  VisitorTransitionType,
} from "../guards/visitor-state-manager";
import {
  notifyResidentsVisitorApprovalRequest,
  resolveVisitorApprovalRecipientIds,
} from "../guards/visitorResidentApproval.service";
import { NotificationService } from "../../services/notification.service";
import { logger } from "../../lib/logger";

const router = Router();

const createVisitorSchema = z.object({
  villaIds: z.array(z.string().cuid()).min(1),
  gateId: z.string().cuid().optional(),
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(10).max(15),
  vehicleNumber: z.string().trim().optional(),
  purpose: z.string().trim().min(3).max(200),
  visitorType: z.nativeEnum(VisitorType).optional(),
});

const checkOutSchema = z.object({
  checkOutAt: z.string().datetime()
});

router.use(requireAuth);

// List all visitors with their villa visits
router.get("/", requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const { start: todayStart } = localDayRange();
    const pagination = getPagination(req);
    const { search, status, gateId, startDate, endDate } = req.query;
    const where: Prisma.VisitorWhereInput = { societyId };

    if (typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
      ];
    }
    if (typeof status === "string" && status.trim()) {
      const s = status.trim().toLowerCase();
      if (s === "active") {
        where.checkOutAt = null;
        where.status = { in: [VisitorStatus.PENDING_APPROVAL, VisitorStatus.APPROVED, VisitorStatus.CHECKED_IN] };
      } else if (s === "checked_out") {
        where.checkOutAt = { not: null };
      }
    }
    if (typeof gateId === "string" && gateId.trim()) {
      where.gateId = gateId.trim();
    }
    if (typeof startDate === "string" && typeof endDate === "string") {
      where.checkInAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }

    const [visitors, total, todayCount] = await Promise.all([
      prisma.visitor.findMany({
        where,
        include: {
          villaVisits: {
            include: {
              villa: {
                select: {
                  villaNumber: true,
                  block: true,
                  ownerName: true
                }
              }
            }
          },
          gate: {
            select: {
              name: true,
              location: true
            }
          }
        },
        orderBy: { checkInAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.visitor.count({ where }),
      prisma.visitor.count({
        where: { societyId, checkInAt: { gte: todayStart } },
      }),
    ]);
    return res.json({ visitors, todayCount, ...paginationMeta(total, visitors.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// Get visitor details
router.get("/:id", requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const visitor = await prisma.visitor.findFirst({
      where: {
        id,
        societyId: req.auth!.societyId
      },
      include: {
        villaVisits: {
          include: {
            villa: {
              select: {
                villaNumber: true,
                block: true,
                ownerName: true
              }
            }
          }
        },
        gate: {
          select: {
            name: true,
            location: true
          }
        }
      }
    });

    if (!visitor) {
      return res.status(404).json({ message: "Visitor not found" });
    }

    return res.json({ visitor });
  } catch (error) {
    next(error);
  }
});

// Create visitor with multiple villa visits
router.post(
  "/",
  requireRole(UserRole.GUARD, UserRole.ADMIN),
  validateBody(createVisitorSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createVisitorSchema>;

      // Verify all villas exist
      const villas = await prisma.villa.findMany({
        where: {
          id: { in: body.villaIds },
          societyId: req.auth!.societyId
        }
      });

      if (villas.length !== body.villaIds.length) {
        return res.status(404).json({ message: "One or more villas not found" });
      }

      const villaVisitsCreate: { villaId: string; unitId: string; notifiedAt: Date }[] = [];
      for (const villaId of body.villaIds) {
        // One row per floor with a resident, so residents on every floor see the visit — not
        // only those on the flat's default floor. A flat nobody lives on falls back to the default.
        const { unitIds } = await occupiedFloorsOfVilla(prisma, {
          societyId: req.auth!.societyId,
          villaId,
        });
        const floors =
          unitIds.length > 0
            ? unitIds
            : [
                await getOrCreateDefaultUnitIdForVilla({
                  societyId: req.auth!.societyId,
                  villaId,
                }),
              ];
        for (const unitId of floors) {
          if (!unitId) {
            return res.status(400).json({
              message:
                "One or more properties have no occupant units. Add at least one unit per villa (e.g. Ground floor / First floor) before checking in visitors.",
            });
          }
          villaVisitsCreate.push({ villaId, unitId, notifiedAt: new Date() });
        }
      }

      if (body.gateId) {
        const gate = await prisma.gate.findFirst({
          where: { id: body.gateId, societyId: req.auth!.societyId },
          select: { id: true },
        });
        if (!gate) {
          return res.status(404).json({ message: "Gate not found in this society" });
        }
      }

      // Create visitor with villa visits
      const visitor = await prisma.visitor.create({
        data: {
          societyId: req.auth!.societyId,
          gateId: body.gateId,
          name: body.name,
          phone: body.phone,
          vehicleNumber: body.vehicleNumber,
          purpose: body.purpose,
          visitorType: body.visitorType || VisitorType.GUEST,
          createdBy: req.auth!.userId,
          villaVisits: {
            create: villaVisitsCreate,
          },
        },
        include: {
          villaVisits: {
            include: {
              villa: {
                select: {
                  villaNumber: true,
                  block: true,
                  ownerName: true
                }
              }
            }
          },
          gate: {
            select: {
              name: true,
              location: true
            }
          }
        }
      });

      return res.status(201).json({ visitor });
    } catch (error) {
      next(error);
    }
  }
);

// Add visitor to additional villa (during their visit)
router.post("/:id/add-villa", requireRole(UserRole.GUARD, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { villaId, notes, unitId: bodyUnitId } = req.body as {
      villaId?: string;
      notes?: string;
      unitId?: string;
    };

    if (!villaId || typeof villaId !== "string") {
      return res.status(400).json({ message: "villaId is required" });
    }

    // Verify visitor exists and is currently checked in
    const visitor = await prisma.visitor.findFirst({
      where: {
        id,
        societyId: req.auth!.societyId,
        checkOutAt: null // Still checked in
      }
    });

    if (!visitor) {
      return res.status(404).json({ message: "Visitor not found or already checked out" });
    }

    const openStatuses: VisitorStatus[] = [
      VisitorStatus.PENDING_APPROVAL,
      VisitorStatus.APPROVED,
      VisitorStatus.CHECKED_IN,
    ];
    if (!openStatuses.includes(visitor.status)) {
      return res.status(400).json({
        message: "This visitor request is closed. Add the visitor again to create a new entry.",
      });
    }

    // Verify villa exists
    const villa = await prisma.villa.findFirst({
      where: {
        id: villaId,
        societyId: req.auth!.societyId
      }
    });

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    let resolvedUnitId: string;
    if (bodyUnitId?.trim()) {
      const unitRow = await prisma.unit.findFirst({
        where: { id: bodyUnitId.trim(), villaId, societyId: req.auth!.societyId },
        select: { id: true },
      });
      if (!unitRow) {
        return res.status(400).json({ message: "Invalid unit for this property" });
      }
      resolvedUnitId = unitRow.id;
    } else {
      const fallback = await getOrCreateDefaultUnitIdForVilla({
        societyId: req.auth!.societyId,
        villaId,
      });
      if (!fallback) {
        return res.status(400).json({
          message:
            "This property has no occupant units. Add at least one unit on the villa before linking this visitor.",
        });
      }
      resolvedUnitId = fallback;
    }

    const existingVisit = await prisma.visitorVilla.findFirst({
      where: { visitorId: id, villaId, unitId: resolvedUnitId },
      select: { id: true, approvalStatus: true },
    });

    if (existingVisit && existingVisit.approvalStatus !== "REJECTED") {
      return res.status(400).json({ message: "Visitor already registered for this property/unit" });
    }

    const villaInclude = { villa: { select: { villaNumber: true, block: true } } } as const;
    // A rejected row for the same flat is reopened as a fresh request (the row is
    // unique per visitor+villa+unit, so a second insert would fail).
    const villaVisit = existingVisit
      ? await prisma.visitorVilla.update({
          where: { id: existingVisit.id },
          data: {
            approvalStatus: "PENDING",
            respondedAt: null,
            respondedByUserId: null,
            notes,
            notifiedAt: new Date(),
          },
          include: villaInclude,
        })
      : await prisma.visitorVilla.create({
          data: {
            visitorId: id,
            villaId,
            unitId: resolvedUnitId,
            notes,
            notifiedAt: new Date(),
          },
          include: villaInclude,
        });

    // The newly added flat must hear about this visitor like the original ones did.
    try {
      if (visitor.status === VisitorStatus.PENDING_APPROVAL) {
        await notifyResidentsVisitorApprovalRequest({
          prisma,
          societyId: req.auth!.societyId,
          visitorId: id,
          visitorName: visitor.name,
          purpose: visitor.purpose,
          villaIds: [villaId],
          targets: [{ villaId, unitId: resolvedUnitId }],
          guardUserId: req.auth!.userId,
          visitorType: visitor.visitorType,
          visitorPhone: visitor.phone,
          visitorPhoto: visitor.photo,
        });
      } else {
        const recipientIds = await resolveVisitorApprovalRecipientIds({
          prisma,
          societyId: req.auth!.societyId,
          villaIds: [villaId],
          targets: [{ villaId, unitId: resolvedUnitId }],
        });
        if (recipientIds.length > 0) {
          await NotificationService.sendToUsers(
            recipientIds,
            {
              title: `Visitor for your flat: ${visitor.name}`,
              body:
                visitor.status === VisitorStatus.CHECKED_IN
                  ? `${visitor.name} is inside the society and is also visiting your flat.`
                  : `${visitor.name} is at the gate and is also visiting your flat.`,
              data: { type: "VISITOR_UPDATE", visitorId: id, visitorName: visitor.name },
            },
            { category: NotificationCategory.VISITOR },
          );
        }
      }
    } catch (notifyErr) {
      logger.error({ err: notifyErr, visitorId: id }, "[add-villa] resident notification failed");
    }

    return res.status(201).json({ villaVisit });
  } catch (error) {
    next(error);
  }
});

// Check out visitor
router.patch(
  "/:id/checkout",
  requireRole(UserRole.GUARD, UserRole.ADMIN),
  validateBody(checkOutSchema),
  async (req, res, next) => {
    try {
      const { checkOutAt } = req.body as z.infer<typeof checkOutSchema>;
      const { id } = req.params;
      const { societyId, userId } = req.auth!;
      const at = new Date(checkOutAt);

      const current = await prisma.visitor.findFirst({
        where: { id, societyId, checkOutAt: null },
        select: { status: true },
      });
      if (!current) {
        return res.status(404).json({ message: "Visitor not found or already checked out" });
      }

      if (current.status === VisitorStatus.DENIED || current.status === VisitorStatus.CANCELLED) {
        // Closed requests: just stamp the exit so the rejection/cancellation stays visible.
        await prisma.visitor.updateMany({
          where: { id, societyId, checkOutAt: null },
          data: { checkOutAt: at, checkOutTime: at, checkedOutByGuardId: userId },
        });
      } else {
        await prisma.$transaction((tx) =>
          transitionVisitorState(tx, {
            visitorId: id,
            fromStatus: current.status,
            toStatus: VisitorStatus.CHECKED_OUT,
            transitionType: VisitorTransitionType.GUARD_CHECKOUT,
            actorUserId: userId,
            societyId,
            timestamp: at,
          }),
        );
      }

      return res.json({ message: "Visitor checked out" });
    } catch (error) {
      if (error instanceof Error && error.message === "VISITOR_STATE_CHANGED") {
        return res
          .status(409)
          .json({ message: "This visitor's status just changed. Please refresh and try again." });
      }
      next(error);
    }
  }
);

// Get active visitors (currently in society)
router.get("/active/list", requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where: Prisma.VisitorWhereInput = {
      societyId: req.auth!.societyId,
      checkOutAt: null,
      status: { in: [VisitorStatus.PENDING_APPROVAL, VisitorStatus.APPROVED, VisitorStatus.CHECKED_IN] },
    };
    const [activeVisitors, total] = await Promise.all([
      prisma.visitor.findMany({
        where,
        include: {
          villaVisits: {
            include: {
              villa: {
                select: {
                  villaNumber: true,
                  block: true,
                },
              },
            },
          },
          gate: {
            select: {
              name: true,
            },
          },
        },
        orderBy: { checkInAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.visitor.count({ where }),
    ]);

    return res.json({
      visitors: activeVisitors,
      ...paginationMeta(total, activeVisitors.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

// Get visitors by villa
router.get("/villa/:villaId", requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const { villaId } = req.params;

    const visitorVillas = await prisma.visitorVilla.findMany({
      where: {
        villaId,
        visitor: {
          societyId: req.auth!.societyId
        }
      },
      include: {
        visitor: {
          include: {
            gate: {
              select: {
                name: true
              }
            }
          }
        }
      },
      orderBy: {
        visitor: {
          checkInAt: "desc"
        }
      },
      take: 50
    });

    return res.json({ visits: visitorVillas });
  } catch (error) {
    next(error);
  }
});

// Delete visitor record (admin only)
router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const societyId = req.auth!.societyId;

      const existing = await prisma.visitor.findFirst({
        where: { id, societyId },
      });

      if (!existing) {
        return res.status(404).json({ message: "Visitor not found" });
      }

      await prisma.$transaction([
        prisma.visitorVilla.deleteMany({ where: { visitorId: id } }),
        prisma.visitor.delete({ where: { id } }),
      ]);

      return res.json({ message: "Visitor record deleted" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
