import { UserRole, VisitorType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { getOrCreateDefaultUnitIdForVilla } from "../../lib/propertyInfrastructure";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createVisitorSchema = z.object({
  villaIds: z.array(z.string().cuid()).min(1),
  gateId: z.string().cuid().optional(),
  name: z.string().min(2).max(100),
  phone: z.string().min(10).max(15),
  vehicleNumber: z.string().optional(),
  purpose: z.string().min(3).max(200),
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
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [visitors, todayCount] = await Promise.all([
      prisma.visitor.findMany({
        where: { societyId },
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
        take: 100
      }),
      prisma.visitor.count({
        where: { societyId, checkInAt: { gte: todayStart } },
      }),
    ]);
    return res.json({ visitors, todayCount });
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
        const unitId = await getOrCreateDefaultUnitIdForVilla({
          societyId: req.auth!.societyId,
          villaId,
        });
        if (!unitId) {
          return res.status(400).json({
            message:
              "One or more properties have no occupant units. Add at least one unit per villa (e.g. Ground floor / First floor) before checking in visitors.",
          });
        }
        villaVisitsCreate.push({ villaId, unitId, notifiedAt: new Date() });
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
      where: {
        visitorId: id,
        villaId,
        unitId: resolvedUnitId,
      },
    });

    if (existingVisit) {
      return res.status(400).json({ message: "Visitor already registered for this property/unit" });
    }

    // Add villa visit
    const villaVisit = await prisma.visitorVilla.create({
      data: {
        visitorId: id,
        villaId,
        unitId: resolvedUnitId,
        notes,
        notifiedAt: new Date()
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true
          }
        }
      }
    });

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

      const visitor = await prisma.visitor.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId,
          checkOutAt: null
        },
        data: { checkOutAt: new Date(checkOutAt), checkOutTime: new Date(checkOutAt) }
      });

      if (visitor.count === 0) {
        return res.status(404).json({ message: "Visitor not found or already checked out" });
      }

      return res.json({ message: "Visitor checked out" });
    } catch (error) {
      next(error);
    }
  }
);

// Get active visitors (currently in society)
router.get("/active/list", requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = {
      societyId: req.auth!.societyId,
      checkOutAt: null,
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

export default router;
