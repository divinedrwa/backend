import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole, VisitorVillaApprovalStatus } from "@prisma/client";
import {
  VISITOR_PENDING_APPROVAL,
  notifyGuardsPreApprovedCreated,
  recomputeVisitorAggregateApproval,
  notifyCreatingGuardVisitorVillaProgress,
} from "../guards/visitorResidentApproval.service";

const router = Router();

router.use(requireAuth);

// Validation schemas
const preApproveVisitorSchema = z.object({
  name: z.string().min(2).max(120).transform((s) => s.trim()),
  phone: z
    .string()
    .min(10)
    .max(18)
    .transform((s) => s.replace(/\D/g, ""))
    .refine((d) => d.length >= 10, { message: "phone must have at least 10 digits" }),
  purpose: z.string().max(2000).optional(),
  validUntil: z.string().datetime().optional(),
  /** Accept legacy client value `SERVICE` and normalize to `SERVICE_PROVIDER` (Prisma enum). */
  visitorType: z.preprocess(
    (v) => (v === "SERVICE" ? "SERVICE_PROVIDER" : v),
    z.enum(["GUEST", "DELIVERY", "SERVICE_PROVIDER", "VENDOR"]).optional(),
  ),
});

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// GET /api/residents/my-visitors - Get my visitor history
router.get("/my-visitors", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { limit = "50", status } = req.query;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Get visitors for user's villa
    const visitors = await prisma.visitor.findMany({
      where: {
        societyId,
        villaVisits: {
          some: {
            villaId: user.villaId,
          },
        },
        ...(status && { status: status as any }),
      },
      include: {
        gate: {
          select: {
            name: true,
            location: true,
          },
        },
        villaVisits: {
          where: { villaId: user.villaId },
          select: {
            villa: {
              select: {
                villaNumber: true,
              },
            },
          },
        },
      },
      orderBy: { checkInTime: "desc" },
      take: parseInt(limit as string),
    });

    // Calculate summary
    const summary = {
      total: visitors.length,
      today: visitors.filter((v) => {
        const today = new Date().toDateString();
        return new Date(v.checkInTime).toDateString() === today;
      }).length,
      checkedIn: visitors.filter((v) => !v.checkOutTime).length,
    };

    return res.json({ visitors, summary });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/visitors-today - Today's visitors
router.get("/visitors-today", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Get today's date range
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const visitors = await prisma.visitor.findMany({
      where: {
        societyId,
        villaVisits: {
          some: {
            villaId: user.villaId,
          },
        },
        checkInTime: {
          gte: today,
          lt: tomorrow,
        },
      },
      include: {
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

// GET /api/residents/my-pre-approved - Get my pre-approved visitors
// GET /api/residents/my-pre-approved-visitors - Alias for mobile app
router.get(["/my-pre-approved", "/my-pre-approved-visitors"], requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const limitRaw = parseInt(String(req.query.limit ?? "200"), 10);
    const take = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const preApproved = await prisma.preApprovedVisitor.findMany({
      where: {
        villaId: user.villaId,
        societyId,
        isActive: true,
      },
      include: {
        villa: { select: { villaNumber: true, block: true } },
      },
      orderBy: { createdAt: "desc" },
      take,
    });

    // Separate by validity
    const now = new Date();
    const active = preApproved.filter((v) => !v.validUntil || new Date(v.validUntil) > now);
    const expired = preApproved.filter((v) => v.validUntil && new Date(v.validUntil) <= now);

    return res.json({
      preApproved,
      summary: {
        total: preApproved.length,
        active: active.length,
        expired: expired.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/pre-approve-visitor - Pre-approve a visitor
router.post("/pre-approve-visitor", requireRole(UserRole.RESIDENT), validateBody(preApproveVisitorSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { name, phone, purpose, validUntil, visitorType } = req.body;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    if (validUntil) {
      const until = new Date(validUntil);
      if (until.getTime() <= Date.now() - 60_000) {
        return res.status(400).json({
          message: "Visit end date/time must be in the future.",
        });
      }
    }

    const otp = generateOtp();
    const preApproved = await prisma.preApprovedVisitor.create({
      data: {
        societyId,
        villaId: user.villaId,
        name,
        phone,
        purpose: typeof purpose === "string" && purpose.trim() ? purpose.trim() : undefined,
        visitorType: visitorType || "GUEST",
        validUntil: validUntil ? new Date(validUntil) : null,
        otp,
        approvedById: userId,
        isActive: true,
      },
      include: {
        villa: { select: { villaNumber: true, block: true } },
      },
    });

    try {
      await notifyGuardsPreApprovedCreated({
        prisma,
        societyId,
        preApprovedId: preApproved.id,
        visitorName: preApproved.name,
        visitorPhone: preApproved.phone,
        villa: preApproved.villa,
      });
    } catch (notifyErr) {
      // eslint-disable-next-line no-console
      console.error("[pre-approve-visitor] guard notify error:", notifyErr);
    }

    return res.status(201).json({
      message: "Visitor pre-approved successfully",
      preApproved,
      otp,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/residents/pre-approved/:id - Remove pre-approval
router.delete("/pre-approved/:id", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Verify ownership
    const preApproved = await prisma.preApprovedVisitor.findFirst({
      where: {
        id,
        villaId: user.villaId,
        societyId,
      },
    });

    if (!preApproved) {
      return res.status(404).json({ message: "Pre-approved visitor not found" });
    }

    // Soft delete by marking inactive
    await prisma.preApprovedVisitor.update({
      where: { id },
      data: { isActive: false },
    });

    return res.json({ message: "Pre-approval removed successfully" });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/pre-approved/:id - Update pre-approval
router.patch("/pre-approved/:id", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;
    const { name, phone, purpose, validUntil } = req.body;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Verify ownership
    const existing = await prisma.preApprovedVisitor.findFirst({
      where: {
        id,
        villaId: user.villaId,
        societyId,
      },
    });

    if (!existing) {
      return res.status(404).json({ message: "Pre-approved visitor not found" });
    }

    const updated = await prisma.preApprovedVisitor.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(purpose && { purpose }),
        ...(validUntil && { validUntil: new Date(validUntil) }),
      },
    });

    return res.json({ message: "Pre-approval updated successfully", preApproved: updated });
  } catch (error) {
    next(error);
  }
});

function pickMyVisit(v: { villaVisits: unknown[] }) {
  return v.villaVisits[0] as
    | {
        approvalStatus: VisitorVillaApprovalStatus;
      }
    | undefined;
}

function visitorApprovalInclude(villaId: string) {
  return {
    gate: { select: { id: true, name: true } },
    villaVisits: {
      where: { villaId },
      include: {
        villa: { select: { id: true, villaNumber: true, block: true } },
      },
    },
  } as const;
}

// GET /api/residents/visitor-approval-requests — fallback list (missed push / inbox)
router.get("/visitor-approval-requests", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const filterRaw = String(req.query.filter ?? "all");
    const filterParsed = z.enum(["pending", "approved", "rejected", "all"]).safeParse(filterRaw);
    const filter = filterParsed.success ? filterParsed.data : "all";

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user?.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const villaId = user.villaId;

    const baseWhere: import("@prisma/client").Prisma.VisitorWhereInput = {
      societyId,
      villaVisits: { some: { villaId } },
    };

    const visitors = await prisma.visitor.findMany({
      where: baseWhere,
      include: visitorApprovalInclude(villaId),
      orderBy: { checkInTime: "desc" },
      take: 80,
    });

    const filtered = visitors.filter((v) => {
      const row = pickMyVisit(v);
      if (!row) return false;
      if (filter === "all") return true;
      if (filter === "pending") {
        return v.status === VISITOR_PENDING_APPROVAL && row.approvalStatus === VisitorVillaApprovalStatus.PENDING;
      }
      if (filter === "approved") {
        return (
          row.approvalStatus === VisitorVillaApprovalStatus.APPROVED ||
          (row.approvalStatus === VisitorVillaApprovalStatus.PENDING &&
            (v.status === "APPROVED" || v.status === "CHECKED_IN"))
        );
      }
      if (filter === "rejected") {
        return (
          row.approvalStatus === VisitorVillaApprovalStatus.REJECTED ||
          (v.status === "REJECTED" && row.approvalStatus === VisitorVillaApprovalStatus.PENDING)
        );
      }
      return true;
    });

    return res.json({ visitors: filtered, count: filtered.length });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/visitor-approval-requests/:visitorId
router.get("/visitor-approval-requests/:visitorId", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { visitorId } = req.params;

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user?.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const visitor = await prisma.visitor.findFirst({
      where: {
        id: visitorId,
        societyId,
        villaVisits: { some: { villaId: user.villaId } },
      },
      include: visitorApprovalInclude(user.villaId),
    });

    if (!visitor) {
      return res.status(404).json({ message: "Visitor request not found" });
    }

    let guardName: string | null = null;
    if (visitor.createdBy) {
      const g = await prisma.user.findUnique({
        where: { id: visitor.createdBy },
        select: { name: true, role: true },
      });
      if (g?.role === UserRole.GUARD) guardName = g.name;
    }

    const mode = (
      await prisma.society.findUnique({
        where: { id: societyId },
        select: { visitorMultiVillaApprovalMode: true },
      })
    )?.visitorMultiVillaApprovalMode;

    return res.json({ visitor, guardName, visitorMultiVillaApprovalMode: mode });
  } catch (error) {
    next(error);
  }
});

function villaLabelFromRow(
  villa: { villaNumber?: string | null; block?: string | null } | null | undefined,
): string {
  if (!villa) return "Flat";
  const parts = [villa.block, villa.villaNumber].filter((x) => typeof x === "string" && x.trim().length > 0);
  return parts.length > 0 ? parts.join(" · ") : "Flat";
}

async function applyResidentVisitorDecision(params: {
  userId: string;
  societyId: string;
  visitorId: string;
  decision: "APPROVE" | "REJECT";
}) {
  const user = await prisma.user.findFirst({
    where: { id: params.userId, societyId: params.societyId },
    select: { villaId: true },
  });

  if (!user?.villaId) {
    return { status: 404 as const, body: { message: "Villa not assigned" } };
  }

  const row = await prisma.visitorVilla.findFirst({
    where: { visitorId: params.visitorId, villaId: user.villaId },
    include: {
      visitor: true,
      villa: { select: { villaNumber: true, block: true } },
    },
  });

  if (!row || row.visitor.societyId !== params.societyId) {
    return { status: 404 as const, body: { message: "Visitor request not found" } };
  }

  const target =
    params.decision === "APPROVE"
      ? VisitorVillaApprovalStatus.APPROVED
      : VisitorVillaApprovalStatus.REJECTED;

  if (row.approvalStatus === target) {
    const { visitor: hydrated } = await recomputeVisitorAggregateApproval(
      prisma,
      params.visitorId,
      params.societyId,
    );
    return {
      status: 200 as const,
      body: {
        message: "Already recorded",
        idempotent: true,
        visitor: hydrated,
      },
    };
  }

  if (row.approvalStatus !== VisitorVillaApprovalStatus.PENDING) {
    return { status: 409 as const, body: { message: "You already responded to this request" } };
  }

  if (row.visitor.status !== VISITOR_PENDING_APPROVAL) {
    return {
      status: 409 as const,
      body: { message: "This visitor request is no longer awaiting approval" },
    };
  }

  await prisma.visitorVilla.update({
    where: { id: row.id },
    data: {
      approvalStatus: target,
      respondedAt: new Date(),
      respondedByUserId: params.userId,
    },
  });

  const { visitor: hydrated, transitioned } = await recomputeVisitorAggregateApproval(
    prisma,
    params.visitorId,
    params.societyId,
  );

  if (
    !transitioned &&
    hydrated?.status === VISITOR_PENDING_APPROVAL &&
    hydrated.createdBy
  ) {
    void notifyCreatingGuardVisitorVillaProgress({
      prisma,
      societyId: params.societyId,
      guardUserId: hydrated.createdBy,
      visitorId: params.visitorId,
      visitorName: hydrated.name,
      decision: params.decision,
      villaLabel: villaLabelFromRow(row.villa),
    });
  }

  return {
    status: 200 as const,
    body: {
      message: params.decision === "APPROVE" ? "Visitor approved" : "Visitor rejected",
      visitor: hydrated,
    },
  };
}

// POST /api/residents/visitor-approval-requests/:visitorId/approve
router.post(
  "/visitor-approval-requests/:visitorId/approve",
  requireRole(UserRole.RESIDENT),
  async (req, res, next) => {
    try {
             const { userId, societyId } = req.auth!;
             const { visitorId } = req.params;
             const result = await applyResidentVisitorDecision({
               userId,
               societyId,
               visitorId,
               decision: "APPROVE",
             });
             return res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/residents/visitor-approval-requests/:visitorId/reject
router.post(
  "/visitor-approval-requests/:visitorId/reject",
  requireRole(UserRole.RESIDENT),
  async (req, res, next) => {
    try {
             const { userId, societyId } = req.auth!;
             const { visitorId } = req.params;
             const result = await applyResidentVisitorDecision({
               userId,
               societyId,
               visitorId,
               decision: "REJECT",
             });
             return res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
