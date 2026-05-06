import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole, NotificationCategory } from "@prisma/client";
import { resolveGuardLogRange } from "./guardLogRange";
import { runVisitorApproveEntry, runVisitorAdmitPreApprovedById } from "./visitorApproveEntryFlow";
import {
  VISITOR_APPROVED_FOR_ENTRY,
  VISITOR_PENDING_APPROVAL,
  notifyResidentsVisitorApprovalRequest,
} from "./visitorResidentApproval.service";
import { NotificationService } from "../../services/notification.service";
import { findActiveGuardShift } from "../../lib/guardShiftActive";

const router = Router();

router.use(requireAuth);

// Validation schemas
const checkInSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(10),
  villaIds: z.array(z.string()).min(1),
  visitorType: z.enum(["GUEST", "DELIVERY", "SERVICE_PROVIDER", "VENDOR"]),
  purpose: z.string().optional(),
  vehicleNumber: z.string().optional(),
  photo: z.string().optional(),
  /** When true, visitor stays pending until resident(s) approve; then guard confirms entry. */
  awaitResidentApproval: z.boolean().optional().default(false),
});

const checkOutSchema = z.object({
  visitorId: z.string(),
});

const verifyPreApprovedSchema = z.object({
  name: z.string(),
  phone: z.string(),
  villaId: z.string(),
});

const otpVerifySchema = z.object({
  otp: z.string().min(4),
  villaId: z.string(),
});

const visitorNotifySchema = z.object({
  villaId: z.string(),
  visitorName: z.string().min(1),
  visitorPhone: z.string().min(8),
  message: z.string().optional(),
});

const approveEntrySchema = z.object({
  otp: z.string().min(4),
  villaId: z.string(),
  visitorName: z.string().optional(),
  visitorPhone: z.string().optional(),
  purpose: z.string().optional(),
  vehicleNumber: z.string().optional(),
});

const preApprovedAdmitSchema = z.object({
  preApprovedId: z.string().min(1),
});

// POST /api/guards/visitor-checkin - Check-in visitor
router.post("/visitor-checkin", requireRole(UserRole.GUARD), validateBody(checkInSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const {
      name,
      phone,
      villaIds,
      visitorType,
      purpose,
      vehicleNumber,
      photo,
      awaitResidentApproval,
    } = req.body;

    const uniqueVillaIds = [...new Set(villaIds as string[])];
    if (uniqueVillaIds.length === 0) {
      return res.status(400).json({ message: "Select at least one flat" });
    }

    const villasOk = await prisma.villa.findMany({
      where: { id: { in: uniqueVillaIds }, societyId },
      select: { id: true },
    });
    if (villasOk.length !== uniqueVillaIds.length) {
      return res.status(404).json({
        message: "One or more flats not found in this society. Refresh the flat list and try again.",
      });
    }

    if (awaitResidentApproval) {
      const residentCount = await prisma.user.count({
        where: {
          societyId,
          role: UserRole.RESIDENT,
          isActive: true,
          villaId: { in: uniqueVillaIds },
        },
      });
      if (residentCount === 0) {
        return res.status(400).json({
          message:
            "No active resident account is mapped to selected flat(s). Assign resident first, then request approval.",
        });
      }
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
        status: awaitResidentApproval ? VISITOR_PENDING_APPROVAL : "CHECKED_IN",
        createdBy: userId,
      },
    });

    // Create villa visits (many-to-many)
    await prisma.visitorVilla.createMany({
      data: uniqueVillaIds.map((villaId) => ({
        visitorId: visitor.id,
        villaId,
        notifiedAt: awaitResidentApproval ? new Date() : null,
      })),
    });

    let residentApprovalRecipientCount = 0;
    if (awaitResidentApproval) {
      try {
        const notifyResult = await notifyResidentsVisitorApprovalRequest({
          prisma,
          societyId,
          visitorId: visitor.id,
          visitorName: name,
          purpose: purpose ?? "",
          villaIds: uniqueVillaIds,
          guardUserId: userId,
          visitorType,
          visitorPhone: phone,
          visitorPhoto: photo,
        });
        residentApprovalRecipientCount = notifyResult.recipientUserCount;
      } catch (notifyErr) {
        // eslint-disable-next-line no-console
        console.error("[visitor-checkin] notifyResidentsVisitorApprovalRequest failed:", notifyErr);
      }
    }

    // Fetch complete visitor with relations
    const completeVisitor = await prisma.visitor.findUnique({
      where: { id: visitor.id },
      include: {
        villaVisits: {
          include: {
            villa: {
              select: {
                villaNumber: true,
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
    });

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
    const { societyId } = req.auth!;
    const { visitorId } = req.body;

    const visitor = await prisma.visitor.findFirst({
      where: { id: visitorId, societyId },
    });

    if (!visitor) {
      return res.status(404).json({ message: "Visitor not found" });
    }

    if (visitor.checkOutTime) {
      return res.status(400).json({ message: "Visitor already checked out" });
    }

    const updated = await prisma.visitor.update({
      where: { id: visitorId },
      data: {
        checkOutTime: new Date(),
        status: "CHECKED_OUT",
      },
    });

    return res.json({
      message: "Visitor checked out successfully",
      visitor: updated,
    });
  } catch (error) {
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
        ...(status && { status: status as any }),
      },
      include: {
        villaVisits: {
          include: {
            villa: {
              select: {
                villaNumber: true,
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

      const updated = await prisma.visitor.update({
        where: { id: visitorId },
        data: { status: "CHECKED_IN" },
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
      next(error);
    }
  },
);

// GET /api/guards/pending-visitors - Awaiting checkout
router.get("/pending-visitors", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const pending = await prisma.visitor.findMany({
      where: {
        societyId,
        checkOutTime: null,
        status: { in: [VISITOR_PENDING_APPROVAL, VISITOR_APPROVED_FOR_ENTRY, "CHECKED_IN"] },
      },
      include: {
        villaVisits: {
          include: {
            villa: {
              select: {
                villaNumber: true,
              },
            },
          },
        },
      },
      orderBy: { checkInTime: "asc" },
    });

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
router.post("/visitor-otp-verify", requireRole(UserRole.GUARD), validateBody(otpVerifySchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { otp, villaId } = req.body;

    const preApproved = await prisma.preApprovedVisitor.findFirst({
      where: {
        societyId,
        villaId,
        otp,
        isActive: true,
        isUsed: false,
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

    if (preApproved.validUntil && new Date(preApproved.validUntil) < new Date()) {
      return res.status(400).json({
        verified: false,
        message: "OTP expired",
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
    const rows = await prisma.preApprovedVisitor.findMany({
      where: {
        societyId,
        isActive: true,
        isUsed: false,
        OR: [{ validUntil: null }, { validUntil: { gte: now } }],
      },
      include: {
        villa: { select: { id: true, villaNumber: true, block: true } },
        approvedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }],
    });
    // eslint-disable-next-line no-console
    console.log("[guards] pre-approved-entries", { societyId, count: rows.length });
    return res.json({ preApproved: rows, count: rows.length });
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

      if (result.status === 201 && result.body.admitted === true) {
        try {
          const visitor = result.body.visitor as
            | {
                id?: string;
                name?: string;
                villaVisits?: Array<{
                  villaId?: string;
                  villa?: { block?: string | null; villaNumber?: string | null } | null;
                }>;
              }
            | undefined;
          const villaVisit = visitor?.villaVisits?.[0];
          const villaId = villaVisit?.villaId;

          if (villaId) {
            const [residents, guard] = await Promise.all([
              prisma.user.findMany({
                where: {
                  societyId,
                  villaId,
                  role: UserRole.RESIDENT,
                  isActive: true,
                },
                select: { id: true },
              }),
              prisma.user.findUnique({
                where: { id: userId },
                select: { name: true },
              }),
            ]);

            const flatParts = [villaVisit?.villa?.block, villaVisit?.villa?.villaNumber].filter(
              (x): x is string => typeof x === "string" && x.trim().length > 0,
            );
            const flatLabel = flatParts.length > 0 ? ` (${flatParts.join(" · ")})` : "";
            const guardName = guard?.name?.trim() || "Security";
            const visitorName = visitor?.name?.trim() || "Your pre-approved visitor";
            const title = "Visitor arrived";
            const body = `${visitorName}${flatLabel} has arrived at the gate. Checked in by ${guardName}.`;
            const data: Record<string, string> = {
              type: "VISITOR_PRE_APPROVED_ARRIVED",
              visitorId: visitor?.id?.toString() ?? "",
              visitorName,
              villaId,
              preApprovedId,
            };

            const notifyResults = await Promise.allSettled(
              residents.map((u) =>
                NotificationService.sendToUser(
                  u.id,
                  { title, body, data },
                  { category: NotificationCategory.VISITOR },
                ),
              ),
            );
            for (const r of notifyResults) {
              if (r.status === "rejected") {
                // eslint-disable-next-line no-console
                console.error("[pre-approved-admit] resident arrival notify failed:", r.reason);
              }
            }
          }
        } catch (notifyErr) {
          // eslint-disable-next-line no-console
          console.error("[pre-approved-admit] resident arrival notify error:", notifyErr);
        }
      }

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
        role: UserRole.RESIDENT,
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
      const results = await Promise.allSettled(
        residents.map((u) =>
          NotificationService.sendToUser(
            u.id,
            { title, body, data },
            { category: NotificationCategory.VISITOR },
          ),
        ),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          // eslint-disable-next-line no-console
          console.error("[visitor-entry-notify] send failed:", r.reason);
        }
      }
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
