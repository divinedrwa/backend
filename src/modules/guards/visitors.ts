import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole, NotificationCategory, VisitorStatus } from "@prisma/client";
import { resolveGuardLogRange } from "./guardLogRange";
import { runVisitorApproveEntry, runVisitorAdmitPreApprovedById } from "./visitorApproveEntryFlow";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import {
  VISITOR_APPROVED_FOR_ENTRY,
  VISITOR_PENDING_APPROVAL,
  notifyResidentsVisitorApprovalRequest,
} from "./visitorResidentApproval.service";
import { NotificationService } from "../../services/notification.service";
import { logger } from "../../lib/logger";
import { findActiveGuardShift } from "../../lib/guardShiftActive";
import { getOrCreateDefaultUnitIdForVilla } from "../../lib/propertyInfrastructure";
import { isPreApprovalGateEligible } from "../../services/preApprovedVisitor.service";
import {
  resolveVisitorApprovalRecipientIds,
  type VisitorApprovalTarget,
} from "./visitorResidentApproval.service";
import {
  transitionVisitorState,
  VisitorTransitionType,
} from "./visitor-state-manager";
import {
  fetchGuardVisitorDetail,
  findGuardClientMutation,
  GUARD_MUTATION_KINDS,
  recordGuardClientMutation,
} from "../../lib/guardClientMutation";

const router = Router();

router.use(requireAuth);

const otpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many OTP attempts. Please wait and try again." },
});

// Validation schemas
const visitTargetSchema = z.object({
  villaId: z.string().min(1),
  unitId: z.string().optional(),
  residentUserId: z.string().optional(),
});

const checkInSchema = z
  .object({
    name: z.string().trim().min(2),
    phone: z.string().trim().min(10),
    /** Legacy: property ids only (uses default unit per property). */
    villaIds: z.array(z.string()).optional(),
    /** Preferred: property + unit + optional specific resident. */
    visitTargets: z.array(visitTargetSchema).optional(),
    visitorType: z.enum(["GUEST", "DELIVERY", "SERVICE_PROVIDER", "VENDOR"]),
    purpose: z.string().trim().optional(),
    vehicleNumber: z.string().trim().optional(),
    photo: z.string().optional(),
    /** When true, visitor stays pending until resident(s) approve; then guard confirms entry. */
    awaitResidentApproval: z.boolean().optional().default(false),
    /** Mobile offline sync: UUID sent by the client for idempotent replay. */
    clientMutationId: z.string().uuid().optional(),
  })
  .refine(
    (d) =>
      (d.villaIds != null && d.villaIds.length > 0) ||
      (d.visitTargets != null && d.visitTargets.length > 0),
    { message: "Select at least one property or visit target", path: ["villaIds"] },
  );

const checkOutSchema = z.object({
  visitorId: z.string(),
  clientMutationId: z.string().uuid().optional(),
});

const verifyPreApprovedSchema = z.object({
  name: z.string().trim(),
  phone: z.string().trim(),
  villaId: z.string(),
});

const otpVerifySchema = z.object({
  otp: z.string().min(4),
  // Optional: an OTP uniquely identifies its pre-approval (and flat) within a
  // society, so a guard can verify an OTP-only arrival without knowing the flat.
  villaId: z.string().optional(),
});

const visitorNotifySchema = z.object({
  villaId: z.string(),
  visitorName: z.string().trim().min(1),
  visitorPhone: z.string().trim().min(8),
  message: z.string().trim().optional(),
});

const approveEntrySchema = z.object({
  otp: z.string().min(4),
  // Optional: admission resolves the flat from the OTP itself, so a guard can
  // admit an OTP-only arrival without selecting a flat.
  villaId: z.string().optional(),
  visitorName: z.string().trim().optional(),
  visitorPhone: z.string().trim().optional(),
  purpose: z.string().trim().optional(),
  vehicleNumber: z.string().trim().optional(),
});

const preApprovedAdmitSchema = z.object({
  preApprovedId: z.string().min(1),
});

// POST /api/guards/visitor-checkin - Check-in visitor
router.post("/visitor-checkin", requireRole(UserRole.GUARD), validateBody(checkInSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const body = req.body as z.infer<typeof checkInSchema>;
    const {
      name,
      phone,
      villaIds,
      visitTargets,
      visitorType,
      purpose,
      vehicleNumber,
      photo,
      awaitResidentApproval,
      clientMutationId,
    } = body;

    if (clientMutationId) {
      const prior = await findGuardClientMutation(societyId, clientMutationId);
      if (prior?.visitorId) {
        const completeVisitor = await fetchGuardVisitorDetail(prior.visitorId);
        if (completeVisitor) {
          return res.status(201).json({
            message: "Visitor checked in successfully",
            visitor: completeVisitor,
            awaitResidentApproval: Boolean(awaitResidentApproval),
            residentApprovalRecipientCount: 0,
            idempotentReplay: true,
          });
        }
      }
    }

    type VisitRow = { villaId: string; unitId: string; residentUserId: string | null };
    const visitRows: VisitRow[] = [];

    if (visitTargets?.length) {
      for (const t of visitTargets) {
        const villaOk = await prisma.villa.findFirst({
          where: { id: t.villaId, societyId },
          select: { id: true },
        });
        if (!villaOk) {
          return res.status(404).json({
            message: "One or more properties not found. Refresh the list and try again.",
          });
        }
        let unitId: string;
        if (t.unitId?.trim()) {
          const unitRow = await prisma.unit.findFirst({
            where: { id: t.unitId.trim(), villaId: t.villaId, societyId },
            select: { id: true },
          });
          if (!unitRow) {
            return res.status(400).json({ message: "Invalid unit for selected property" });
          }
          unitId = unitRow.id;
        } else if (t.residentUserId?.trim()) {
          const resident = await prisma.user.findFirst({
            where: {
              id: t.residentUserId.trim(),
              societyId,
              villaId: t.villaId,
              isActive: true,
            },
            select: { unitId: true },
          });
          if (resident?.unitId) {
            unitId = resident.unitId;
          } else {
            const resolved = await getOrCreateDefaultUnitIdForVilla({
              societyId,
              villaId: t.villaId,
            });
            if (!resolved) {
              return res.status(400).json({
                message:
                  "This property has no occupant units. Add units on the villa (e.g. Ground floor / First floor) before check-in.",
              });
            }
            unitId = resolved;
          }
        } else {
          const resolved = await getOrCreateDefaultUnitIdForVilla({
            societyId,
            villaId: t.villaId,
          });
          if (!resolved) {
            return res.status(400).json({
              message:
                "This property has no occupant units. Add units on the villa (e.g. Ground floor / First floor) before check-in.",
            });
          }
          unitId = resolved;
        }
        visitRows.push({
          villaId: t.villaId,
          unitId,
          residentUserId: t.residentUserId?.trim() || null,
        });
      }
    } else if (villaIds?.length) {
      const uniqueVillaIds = [...new Set(villaIds)];
      const villasOk = await prisma.villa.findMany({
        where: { id: { in: uniqueVillaIds }, societyId },
        select: { id: true },
      });
      if (villasOk.length !== uniqueVillaIds.length) {
        return res.status(404).json({
          message: "One or more flats not found in this society. Refresh the flat list and try again.",
        });
      }
      for (const villaId of uniqueVillaIds) {
        const resolved = await getOrCreateDefaultUnitIdForVilla({ societyId, villaId });
        if (!resolved) {
          return res.status(400).json({
            message:
              "One or more properties have no occupant units. Add at least one unit per villa before check-in.",
          });
        }
        visitRows.push({ villaId, unitId: resolved, residentUserId: null });
      }
    }

    const uniqueVillaIds = [...new Set(visitRows.map((r) => r.villaId))];

    const notifyTargets: VisitorApprovalTarget[] = visitRows.map((r) => ({
      villaId: r.villaId,
      unitId: r.residentUserId ? undefined : r.unitId,
      residentUserId: r.residentUserId ?? undefined,
    }));

    if (awaitResidentApproval) {
      const recipientIds = await resolveVisitorApprovalRecipientIds({
        prisma,
        societyId,
        villaIds: uniqueVillaIds,
        targets: notifyTargets,
      });
      if (recipientIds.length === 0) {
        return res.status(400).json({
          message:
            "No active resident account matches the selected unit or occupant. Assign residents first, then request approval.",
        });
      }
    }

    // Duplicate check-in prevention: reject if same phone is already checked in
    const existingActive = await prisma.visitor.findFirst({
      where: {
        societyId,
        phone,
        checkOutTime: null,
        checkOutAt: null,
      },
    });
    if (existingActive) {
      return res.status(409).json({ message: "This visitor is already checked in. Please check them out first." });
    }

    const now = new Date();
    const shift = await findActiveGuardShift(prisma, {
      guardId: userId,
      societyId,
      now,
    });

    if (!shift) {
      return res.status(400).json({ message: "No active shift found" });
    }

    // Create visitor
    const visitor = await prisma.visitor.create({
      data: {
        societyId,
        gateId: shift.gateId,
        name,
        phone,
        visitorType,
        purpose: purpose ?? "",
        vehicleNumber,
        photo,
        checkInTime: new Date(),
        status: awaitResidentApproval ? VISITOR_PENDING_APPROVAL : "CHECKED_IN" as VisitorStatus,
        createdBy: userId,
      },
    });

    await prisma.visitorVilla.createMany({
      data: visitRows.map((r) => ({
        visitorId: visitor.id,
        villaId: r.villaId,
        unitId: r.unitId,
        residentUserId: r.residentUserId,
        notifiedAt: awaitResidentApproval ? new Date() : null,
      })),
    });

    let residentApprovalRecipientCount = 0;
    if (awaitResidentApproval) {
      // Must await: the response payload (residentApprovalRecipientCount + the
      // "no resident accounts linked" message) depends on the recipient count.
      try {
        const notifyResult = await notifyResidentsVisitorApprovalRequest({
          prisma,
          societyId,
          visitorId: visitor.id,
          visitorName: name,
          purpose: purpose ?? "",
          villaIds: uniqueVillaIds,
          targets: notifyTargets,
          guardUserId: userId,
          visitorType,
          visitorPhone: phone,
          visitorPhoto: photo,
        });
        residentApprovalRecipientCount = notifyResult.recipientUserCount;
      } catch (notifyErr) {
        logger.error(
          { err: notifyErr },
          "[visitor-checkin] notifyResidentsVisitorApprovalRequest failed",
        );
      }
    }

    // Fetch complete visitor with relations
    const completeVisitor = await fetchGuardVisitorDetail(visitor.id);

    if (clientMutationId) {
      await recordGuardClientMutation({
        societyId,
        guardUserId: userId,
        clientMutationId,
        kind: GUARD_MUTATION_KINDS.VISITOR_CHECK_IN,
        visitorId: visitor.id,
      });
    }

    return res.status(201).json({
      message:
        awaitResidentApproval && residentApprovalRecipientCount == 0
          ? "Visitor request created, but no resident accounts are linked to selected flat(s)"
          : "Visitor checked in successfully",
      visitor: completeVisitor,
      awaitResidentApproval: Boolean(awaitResidentApproval),
      residentApprovalRecipientCount,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/visitor-checkout - Check-out visitor
router.post("/visitor-checkout", requireRole(UserRole.GUARD), validateBody(checkOutSchema), async (req, res, next) => {
  try {
    const { societyId, userId } = req.auth!;
    const { visitorId, clientMutationId } = req.body as z.infer<typeof checkOutSchema>;

    if (clientMutationId) {
      const prior = await findGuardClientMutation(societyId, clientMutationId);
      if (prior?.visitorId === visitorId) {
        const updated = await fetchGuardVisitorDetail(visitorId);
        return res.json({
          message: "Visitor checked out successfully",
          visitor: updated,
          idempotentReplay: true,
        });
      }
    }

    const visitor = await prisma.visitor.findFirst({
      where: { id: visitorId, societyId },
    });

    if (!visitor) {
      return res.status(404).json({ message: "Visitor not found" });
    }

    if (visitor.checkOutTime) {
      const updated = await fetchGuardVisitorDetail(visitorId);
      return res.json({
        message: "Visitor already checked out",
        visitor: updated,
        idempotentReplay: true,
      });
    }

  // Use centralized state manager for checkout
  await prisma.$transaction(async (tx) => {
    return await transitionVisitorState(tx, {
      visitorId,
      fromStatus: visitor.status,
      toStatus: VisitorStatus.CHECKED_OUT,
      transitionType: VisitorTransitionType.GUARD_CHECKOUT,
      actorUserId: userId,
      societyId,
      timestamp: new Date(),
    });
  });

    const updated = await fetchGuardVisitorDetail(visitorId);

    if (clientMutationId) {
      await recordGuardClientMutation({
        societyId,
        guardUserId: userId,
        clientMutationId,
        kind: GUARD_MUTATION_KINDS.VISITOR_CHECK_OUT,
        visitorId,
      });
    }

    return res.json({
      message: "Visitor checked out successfully",
      visitor: updated,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "VISITOR_STATE_CHANGED") {
      return res
        .status(409)
        .json({ message: "This visitor's status just changed. Please refresh and try again." });
    }
    next(error);
  }
});

// GET /api/guards/visitors-today - Today's visitors
// GET /api/guards/my-visitors - Alias for mobile app
router.get(["/visitors-today", "/my-visitors"], requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { status } = req.query;

    const range = resolveGuardLogRange(req.query as Record<string, unknown>);
    if (!range.ok) {
      return res.status(400).json({ message: range.message });
    }

    const visitors = await prisma.visitor.findMany({
      where: {
        societyId,
        checkInTime: { gte: range.start, lte: range.endInclusive },
        ...(status && { status: status as VisitorStatus }),
      },
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
      orderBy: { checkInTime: "desc" },
      // Defensive cap: the range is client-supplied, so bound the result. The
      // day view is well under this; the summary is computed from what's returned.
      take: 1000,
    });

    const checkedIn = visitors.filter((v) => !v.checkOutTime);
    const checkedOut = visitors.filter((v) => v.checkOutTime);

    return res.json({
      visitors,
      summary: {
        total: visitors.length,
        checkedIn: checkedIn.length,
        checkedOut: checkedOut.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

const confirmEntrySchema = z.object({
  visitorId: z.string().min(1),
});

// POST /api/guards/visitor-confirm-entry — after residents APPROVED, guard marks guest on premises
router.post(
  "/visitor-confirm-entry",
  requireRole(UserRole.GUARD),
  validateBody(confirmEntrySchema),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { visitorId } = req.body as z.infer<typeof confirmEntrySchema>;

      const now = new Date();
      const shift = await findActiveGuardShift(prisma, {
        guardId: userId,
        societyId,
        now,
      });

      if (!shift) {
        return res.status(400).json({ message: "No active shift found" });
      }

      const visitor = await prisma.visitor.findFirst({
        where: { id: visitorId, societyId },
      });

      if (!visitor) {
        return res.status(404).json({ message: "Visitor not found" });
      }

      if (visitor.status !== VISITOR_APPROVED_FOR_ENTRY) {
        return res.status(400).json({
          message:
            visitor.status === VISITOR_PENDING_APPROVAL
              ? "Awaiting resident approval"
              : "Visitor cannot be confirmed in this state",
        });
      }

      if (visitor.checkOutTime) {
        return res.status(400).json({ message: "Visitor already checked out" });
      }

    // Use centralized state manager for final admission
    await prisma.$transaction(async (tx) => {
      return await transitionVisitorState(tx, {
        visitorId,
        fromStatus: visitor.status,
        toStatus: VisitorStatus.CHECKED_IN,
        transitionType: VisitorTransitionType.GUARD_ADMIT,
        actorUserId: userId,
        societyId,
        timestamp: now,
      });
    });

      const updated = await prisma.visitor.findUnique({
        where: { id: visitorId },
        include: {
          villaVisits: {
            include: {
              villa: { select: { villaNumber: true } },
            },
          },
          gate: { select: { name: true } },
        },
      });

      return res.json({
        message: "Entry confirmed — visitor checked in",
        visitor: updated,
      });
    } catch (error) {
      // A resident may have rejected (or another guard acted) between our read
      // and the guarded transition — surface a clean conflict, not a 500.
      if (error instanceof Error && error.message === "VISITOR_STATE_CHANGED") {
        return res
          .status(409)
          .json({ message: "This visitor's status just changed. Please refresh and try again." });
      }
      next(error);
    }
  },
);

// GET /api/guards/pending-visitors - Awaiting checkout
router.get("/pending-visitors", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    // This is a "show all currently on-site" list (not client-paginated), so
    // use a generous defensive cap rather than a small page size — big enough
    // for any realistic gate, bounded so a runaway can't return unbounded rows.
    const ON_SITE_CAP = 300;
    const pending = await prisma.visitor.findMany({
      where: {
        societyId,
        checkOutTime: null,
        status: { in: [VISITOR_PENDING_APPROVAL, VISITOR_APPROVED_FOR_ENTRY, VisitorStatus.CHECKED_IN] },
      },
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
      },
      orderBy: { checkInTime: "asc" },
      take: ON_SITE_CAP,
    });
    if (pending.length === ON_SITE_CAP) {
      logger.warn({ societyId, cap: ON_SITE_CAP }, "[guards] pending-visitors hit cap");
    }

    return res.json({ visitors: pending, count: pending.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/verify-pre-approved - Verify pre-approved visitor
router.post("/verify-pre-approved", requireRole(UserRole.GUARD), validateBody(verifyPreApprovedSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { name, phone, villaId } = req.body;

    const preApproved = await prisma.preApprovedVisitor.findFirst({
      where: {
        societyId,
        villaId,
        name: { contains: name, mode: "insensitive" },
        phone: { contains: phone },
        isActive: true,
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
          },
        },
      },
    });

    if (!preApproved) {
      return res.status(404).json({
        verified: false,
        message: "Visitor not in pre-approved list",
      });
    }

    // Check validity
    if (preApproved.validUntil && new Date(preApproved.validUntil) < new Date()) {
      return res.status(400).json({
        verified: false,
        message: "Pre-approval expired",
        preApproved,
      });
    }

    return res.json({
      verified: true,
      message: "Visitor verified successfully",
      preApproved,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/visitor-otp-verify — validate pre-approved OTP at gate
router.post("/visitor-otp-verify", otpRateLimiter, requireRole(UserRole.GUARD), validateBody(otpVerifySchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { otp, villaId } = req.body as { otp: string; villaId?: string };

    // OTP alone identifies the pre-approval within a society, so villaId is
    // optional — a guard can verify an OTP-only arrival without knowing the flat.
    const preApproved = await prisma.preApprovedVisitor.findFirst({
      where: {
        societyId,
        otp,
        isActive: true,
        ...(villaId ? { villaId } : {}),
      },
      include: {
        villa: { select: { villaNumber: true, block: true } },
      },
    });

    if (!preApproved) {
      return res.status(404).json({
        verified: false,
        message: "OTP not found or already used",
      });
    }

    // Match the admit path's validity rules (not-yet-valid / expired / used up),
    // so a green "verified" can never be followed by a failed admit.
    const now = new Date();
    if (preApproved.validFrom && new Date(preApproved.validFrom) > now) {
      return res.status(400).json({
        verified: false,
        message: "This pass is not valid yet.",
        preApproved,
      });
    }
    if (!isPreApprovalGateEligible(preApproved, now)) {
      return res.status(400).json({
        verified: false,
        message:
          preApproved.validUntil && new Date(preApproved.validUntil) <= now
            ? "OTP expired"
            : "OTP has already been used",
        preApproved,
      });
    }

    return res.json({
      verified: true,
      message: "OTP verified",
      preApproved,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/visitor-approve-entry — atomic verify + consume OTP + visitor check-in
router.post(
  "/visitor-approve-entry",
  otpRateLimiter,
  requireRole(UserRole.GUARD),
  validateBody(approveEntrySchema),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { otp, villaId, visitorName, visitorPhone, purpose, vehicleNumber } = req.body;

      const result = await runVisitorApproveEntry(prisma, {
        userId,
        societyId,
        otp,
        villaId,
        visitorName,
        visitorPhone,
        purpose,
        vehicleNumber,
      });

      // The resident arrival push (VISITOR_PRE_APPROVED_ARRIVED) is sent inside
      // admitPreApprovedVisitor (visitor-state-manager). This route-level block
      // was dead code (the flow returns 200, never 201) and, if re-enabled,
      // would double-notify — so it's intentionally removed.
      return res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/guards/pre-approved-entries — all society pre-approvals not yet admitted (guard pick list)
router.get("/pre-approved-entries", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const now = new Date();
    const pagination = getPagination(req);
    const where = {
      societyId,
      isActive: true,
      isUsed: false,
      OR: [{ validUntil: null }, { validUntil: { gte: now } }],
    };
    const [rows, total] = await Promise.all([
      prisma.preApprovedVisitor.findMany({
        where,
        include: {
          villa: { select: { id: true, villaNumber: true, block: true } },
          approvedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }],
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.preApprovedVisitor.count({ where }),
    ]);
    // Drop passes that would be rejected on admit — notably RECURRING passes
    // that have hit maxUses (their `isUsed` stays false, so the `where` above
    // can't exclude them). Prevents the guard tapping an entry that then fails.
    const eligible = rows.filter((r) => isPreApprovalGateEligible(r, now));
    logger.info(
      { societyId, count: eligible.length },
      "[guards] pre-approved-entries",
    );
    return res.json({
      preApproved: eligible,
      count: total,
      ...paginationMeta(total, eligible.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/pre-approved-admit — one-tap check-in from guard list (consumes pre-approval)
router.post(
  "/pre-approved-admit",
  requireRole(UserRole.GUARD),
  validateBody(preApprovedAdmitSchema),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { preApprovedId } = req.body as z.infer<typeof preApprovedAdmitSchema>;
      const result = await runVisitorAdmitPreApprovedById(prisma, {
        userId,
        societyId,
        preApprovedId,
      });

      // Resident arrival push is sent inside admitPreApprovedVisitor; the
      // former route-level block here was dead (flow returns 200) and would
      // double-notify if re-enabled — removed intentionally.
      return res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/guards/visitor-entry-notify — ping residents of villa (in-app inbox)
router.post("/visitor-entry-notify", requireRole(UserRole.GUARD), validateBody(visitorNotifySchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { villaId, visitorName, visitorPhone, message } = req.body;

    const villa = await prisma.villa.findFirst({
      where: { id: villaId, societyId },
    });
    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    const residents = await prisma.user.findMany({
      where: {
        societyId,
        villaId,
        // Include admins who occupy this villa (role ADMIN).
        ...residentLikeRoleFilter,
        isActive: true,
      },
      select: { id: true },
    });

    const body =
      message?.trim() ||
      `Visitor at gate: ${visitorName} (${visitorPhone}). Please approve or deny.`;

    const title = "Visitor at gate";
    const data: Record<string, string> = {
      type: "VISITOR_GATE_NOTIFY",
      villaId,
      visitorName,
      visitorPhone,
    };

    if (residents.length > 0) {
      await NotificationService.sendToUsers(
        residents.map((u) => u.id),
        { title, body, data },
        { category: NotificationCategory.VISITOR },
      );
    }

    return res.json({
      message: "Residents notified",
      notifiedCount: residents.length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
