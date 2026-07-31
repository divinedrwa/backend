import { Router } from "express";
import rateLimit from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import {
  localDayRange,
  summarizeVisitorsToday,
  visitorIsInside,
} from "../../lib/visitorLifecycle";
import {
  findResidentVisitorVillaRow,
  residentVisitorVillaVisitWhere,
  visitorApprovalIncludeForResident,
} from "../../lib/residentVisitorApprovalScope";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import {
  NotificationCategory,
  UserRole,
  VisitorStatus,
  VisitorVillaApprovalStatus,
} from "@prisma/client";
import {
  VISITOR_PENDING_APPROVAL,
  VISITOR_APPROVED_FOR_ENTRY,
  VISITOR_REJECTED,
  recomputeVisitorAggregateApproval,
  notifyCreatingGuardVisitorVillaProgress,
  notifyGuardsVisitorApprovalOutcome,
  notifyResidentsVisitorApprovalResolved,
} from "../guards/visitorResidentApproval.service";
import {
  createPreApprovedVisitor,
  deactivatePreApprovedVisitor,
  issuePreApprovedVisitorPublicLink,
  listPreApprovedVisitors,
  mapPreApprovedForClient,
  mapPreApprovedForMobile,
} from "../../services/preApprovedVisitor.service";
import {
  revokePreApprovedPublicLink,
  listPreApprovedPassViews,
} from "../../services/visitorPassAudit.service";
import { notifySocietyRoles, notifyUsers } from "../../services/notification.service";
import { logger } from "../../lib/logger";

const router = Router();

router.use(requireAuth);

const wrongEntryReportSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Reason is required")
    .max(200, "Reason is too long"),
  residentNote: z.string().trim().max(1000).optional().nullable(),
});

function visitorIsOverstay(visitor: {
  status: VisitorStatus;
  checkOutAt: Date | null;
  expectedCheckoutAt: Date | null;
}): boolean {
  if (!visitorIsInside(visitor)) return false;
  if (!visitor.expectedCheckoutAt) return false;
  return visitor.expectedCheckoutAt.getTime() < Date.now();
}

function enrichVisitorForResident<
  T extends {
    status: VisitorStatus;
    checkOutAt: Date | null;
    expectedCheckoutAt: Date | null;
    wrongEntryReports?: { id: string; status: string; createdAt: Date }[];
  },
>(visitor: T) {
  const reports = visitor.wrongEntryReports ?? [];
  const { wrongEntryReports: _omit, ...rest } = visitor;
  return {
    ...rest,
    isOverstay: visitorIsOverstay(visitor),
    wrongEntryReported: reports.length > 0,
    wrongEntryReport: reports[0] ?? null,
  };
}

const preApproveRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: "Too many pre-approval requests, please try again later",
});

const wrongEntryRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many wrong-entry reports, please try again later",
});

// Validation schemas
const preApproveVisitorSchema = z.object({
  name: z.string().min(2).max(120).transform((s) => s.trim()),
  phone: z
    .string()
    .min(10)
    .max(18)
    .transform((s) => s.replace(/\D/g, ""))
    .refine((d) => d.length >= 10, { message: "phone must have at least 10 digits" }),
  purpose: z.string().trim().max(2000).optional(),
  validUntil: z.string().datetime().optional(),
  /** Accept legacy client value `SERVICE` and normalize to `SERVICE_PROVIDER` (Prisma enum). */
  visitorType: z.preprocess(
    (v) => (v === "SERVICE" ? "SERVICE_PROVIDER" : v),
    z.enum(["GUEST", "DELIVERY", "CAB", "SERVICE_PROVIDER", "VENDOR"]).optional(),
  ),
  /** Recurring pass: allows multiple uses within the validity window. */
  isRecurring: z.boolean().optional(),
  /** Max uses for recurring pass. Null = unlimited. */
  maxUses: z.number().int().min(1).max(365).optional(),
});

const updatePreApprovedVisitorSchema = z.object({
  name: z.string().min(2).max(120).transform((s) => s.trim()).optional(),
  phone: z
    .string()
    .min(10)
    .max(18)
    .transform((s) => s.replace(/\D/g, ""))
    .refine((d) => d.length >= 10, { message: "phone must have at least 10 digits" })
    .optional(),
  purpose: z.string().trim().max(2000).optional(),
  validUntil: z.string().datetime().optional().nullable(),
});

// GET /api/residents/my-visitors - Get my visitor history
router.get("/my-visitors", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const pagination = getPagination(req);
    const { status } = req.query;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, unitId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const visitMatch = {
      villaId: user.villaId,
      ...(user.unitId ? { unitId: user.unitId } : {}),
    };

    const where = {
      societyId,
      villaVisits: {
        some: visitMatch,
      },
      ...(status &&
        (Object.values(VisitorStatus) as string[]).includes(status as string) && {
          status: status as VisitorStatus,
        }),
    };

    const [visitors, total] = await Promise.all([
      prisma.visitor.findMany({
        where,
        include: {
          gate: {
            select: {
              name: true,
              location: true,
            },
          },
          villaVisits: {
            where: visitMatch,
            select: {
              villa: {
                select: {
                  villaNumber: true,
                },
              },
              unit: { select: { label: true, unitCode: true } },
            },
          },
          wrongEntryReports: {
            where: { reportedByUserId: userId },
            select: { id: true, status: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: { checkInTime: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.visitor.count({ where }),
    ]);

    // Calculate summary
    const enriched = visitors.map(enrichVisitorForResident);
    const summary = {
      total,
      today: enriched.filter((v) => {
        const today = new Date().toDateString();
        return new Date(v.checkInTime).toDateString() === today;
      }).length,
      checkedIn: enriched.filter((v) => visitorIsInside(v)).length,
      overstay: enriched.filter((v) => v.isOverstay).length,
    };

    return res.json({ visitors: enriched, summary, ...paginationMeta(total, enriched.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/visitors-today - Today's visitors
router.get("/visitors-today", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, unitId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const visitMatch = {
      villaId: user.villaId,
      ...(user.unitId ? { unitId: user.unitId } : {}),
    };

    const { start: today, end: tomorrow } = localDayRange();

    const visitors = await prisma.visitor.findMany({
      where: {
        societyId,
        villaVisits: {
          some: visitMatch,
        },
        OR: [
          { checkInTime: { gte: today, lt: tomorrow } },
          { checkInAt: { gte: today, lt: tomorrow } },
        ],
      },
      include: {
        gate: {
          select: {
            name: true,
          },
        },
        wrongEntryReports: {
          where: { reportedByUserId: userId },
          select: { id: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { checkInTime: "desc" },
    });

    const enriched = visitors.map(enrichVisitorForResident);
    const summary = summarizeVisitorsToday(visitors);

    return res.json({
      visitors: enriched,
      summary: {
        ...summary,
        overstay: enriched.filter((v) => v.isOverstay).length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/my-pre-approved - Get my pre-approved visitors
// GET /api/residents/my-pre-approved-visitors - Alias for mobile app
router.get(["/my-pre-approved", "/my-pre-approved-visitors"], requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const limitRaw = parseInt(String(req.query.limit ?? "200"), 10);
    const take = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const { rows, summary } = await listPreApprovedVisitors(prisma, {
      societyId,
      villaId: user.villaId,
      take,
    });

    const mapped = rows.map((v) => mapPreApprovedForMobile(v));

    return res.json({
      preApproved: mapped,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/pre-approve-visitor - Pre-approve a visitor
router.post("/pre-approve-visitor", preApproveRateLimiter, requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(preApproveVisitorSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { name, phone, purpose, validUntil, visitorType, isRecurring, maxUses } = req.body;

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const preApproved = await createPreApprovedVisitor(prisma, {
      societyId,
      villaId: user.villaId,
      approvedById: userId,
      name,
      phone,
      purpose: typeof purpose === "string" && purpose.trim() ? purpose.trim() : undefined,
      visitorType: visitorType || "GUEST",
      validUntil: validUntil ? new Date(validUntil) : null,
      isRecurring: isRecurring ?? false,
      maxUses: isRecurring ? (maxUses ?? null) : null,
    });

    const otp = preApproved.otp ?? "";
    return res.status(201).json({
      message: "Visitor pre-approved successfully",
      preApproved: mapPreApprovedForMobile(preApproved),
      otp,
      passcode: otp,
      publicPassUrl: preApproved.publicPassUrl,
    });
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode: number }).statusCode)
        : undefined;
    if (statusCode) {
      return res.status(statusCode).json({
        message: error instanceof Error ? error.message : "Request failed",
      });
    }
    next(error);
  }
});

// POST /api/residents/pre-approved/:id/share-link — rotate and return a new
// public browser-pass URL. Rotating invalidates any previously shared URL.
router.post(
  "/pre-approved/:id/share-link",
  preApproveRateLimiter,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId, role, villaId } = req.auth!;
      const result = await issuePreApprovedVisitorPublicLink(prisma, {
        id: req.params.id,
        societyId,
        role,
        actorVillaId: villaId,
      });
      return res.json(result);
    } catch (error) {
      const statusCode =
        error && typeof error === "object" && "statusCode" in error
          ? Number((error as { statusCode: number }).statusCode)
          : undefined;
      if (statusCode) {
        return res.status(statusCode).json({
          message: error instanceof Error ? error.message : "Request failed",
        });
      }
      next(error);
    }
  },
);

// POST /api/residents/pre-approved/:id/revoke-link — invalidate shared browser URL (pass stays active)
router.post(
  "/pre-approved/:id/revoke-link",
  preApproveRateLimiter,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId, role, villaId } = req.auth!;
      await revokePreApprovedPublicLink(prisma, {
        id: req.params.id,
        societyId,
        role,
        actorVillaId: villaId,
      });
      return res.json({ message: "Share link revoked" });
    } catch (error) {
      const statusCode =
        error && typeof error === "object" && "statusCode" in error
          ? Number((error as { statusCode: number }).statusCode)
          : undefined;
      if (statusCode) {
        return res.status(statusCode).json({
          message: error instanceof Error ? error.message : "Request failed",
        });
      }
      next(error);
    }
  },
);

// GET /api/residents/pre-approved/:id/pass-views — audit of public pass opens
router.get(
  "/pre-approved/:id/pass-views",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId, role, villaId } = req.auth!;
      const limit = req.query.limit
        ? Number.parseInt(String(req.query.limit), 10)
        : undefined;
      const result = await listPreApprovedPassViews(prisma, {
        id: req.params.id,
        societyId,
        role,
        actorVillaId: villaId,
        limit,
      });
      return res.json(result);
    } catch (error) {
      const statusCode =
        error && typeof error === "object" && "statusCode" in error
          ? Number((error as { statusCode: number }).statusCode)
          : undefined;
      if (statusCode) {
        return res.status(statusCode).json({
          message: error instanceof Error ? error.message : "Request failed",
        });
      }
      next(error);
    }
  },
);

// DELETE /api/residents/pre-approved/:id - Remove pre-approval
router.delete("/pre-approved/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId, role, villaId: authVillaId } = req.auth!;
    const { id } = req.params;

    if (role === UserRole.RESIDENT) {
      const user = await prisma.user.findFirst({
        where: { id: userId, societyId },
        select: { villaId: true },
      });

      if (!user?.villaId) {
        return res.status(404).json({ message: "Villa not assigned" });
      }

      try {
        await deactivatePreApprovedVisitor(prisma, {
          id,
          societyId,
          role,
          actorVillaId: user.villaId,
        });
      } catch (error) {
        const statusCode =
          error && typeof error === "object" && "statusCode" in error
            ? Number((error as { statusCode: number }).statusCode)
            : undefined;
        if (statusCode) {
          return res.status(statusCode).json({
            message: error instanceof Error ? error.message : "Request failed",
          });
        }
        throw error;
      }
    } else {
      try {
        await deactivatePreApprovedVisitor(prisma, {
          id,
          societyId,
          role,
          actorVillaId: authVillaId,
        });
      } catch (error) {
        const statusCode =
          error && typeof error === "object" && "statusCode" in error
            ? Number((error as { statusCode: number }).statusCode)
            : undefined;
        if (statusCode) {
          return res.status(statusCode).json({
            message: error instanceof Error ? error.message : "Request failed",
          });
        }
        throw error;
      }
    }

    return res.json({ message: "Pre-approval removed successfully" });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/pre-approved/:id - Update pre-approval
router.patch("/pre-approved/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(updatePreApprovedVisitorSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;
    const body = req.body as z.infer<typeof updatePreApprovedVisitorSchema>;

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
        ...(body.name !== undefined && { name: body.name }),
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.purpose !== undefined && { purpose: body.purpose }),
        ...(body.validUntil !== undefined && { validUntil: body.validUntil ? new Date(body.validUntil) : null }),
      },
    });

    return res.json({
      message: "Pre-approval updated successfully",
      preApproved: mapPreApprovedForClient(updated),
    });
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

// GET /api/residents/visitor-approval-requests — fallback list (missed push / inbox)
router.get("/visitor-approval-requests", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    // Mobile clients send `?status=pending`; older clients send `?filter=...`.
    // Prefer `status` when present, fall back to `filter` for back-compat.
    const filterRaw = String(req.query.status ?? req.query.filter ?? "all");
    const filterParsed = z.enum(["pending", "approved", "rejected", "all"]).safeParse(filterRaw);
    const filter = filterParsed.success ? filterParsed.data : "all";

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, unitId: true },
    });

    if (!user?.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const villaId = user.villaId;
    const visitSome = residentVisitorVillaVisitWhere({
      villaId,
      userId,
      unitId: user.unitId,
    });

    const baseWhere: Prisma.VisitorWhereInput = {
      societyId,
      villaVisits: { some: visitSome },
    };

    // For the "pending" tab, push the visitor-level status filter into the query
    // so we don't fetch 80 rows of every status and drop most of them in JS.
    // The villa-row approvalStatus === PENDING check still runs below (it targets
    // this resident's specific villa row, which the aggregate logic needs intact).
    if (filter === "pending") {
      baseWhere.status = VISITOR_PENDING_APPROVAL;
    }

    const visitors = await prisma.visitor.findMany({
      where: baseWhere,
      include: visitorApprovalIncludeForResident(villaId, userId, user.unitId),
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
          (v.status === VisitorStatus.DENIED && row.approvalStatus === VisitorVillaApprovalStatus.PENDING)
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
router.get("/visitor-approval-requests/:visitorId", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { visitorId } = req.params;

    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true, unitId: true },
    });

    if (!user?.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const visitSome = residentVisitorVillaVisitWhere({
      villaId: user.villaId,
      userId,
      unitId: user.unitId,
    });

    const visitor = await prisma.visitor.findFirst({
      where: {
        id: visitorId,
        societyId,
        villaVisits: { some: visitSome },
      },
      include: visitorApprovalIncludeForResident(user.villaId, userId, user.unitId),
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
    select: { villaId: true, unitId: true },
  });

  if (!user?.villaId) {
    return { status: 404 as const, body: { message: "Villa not assigned" } };
  }

  const row = await findResidentVisitorVillaRow(prisma, {
    visitorId: params.visitorId,
    societyId: params.societyId,
    userId: params.userId,
    villaId: user.villaId,
    unitId: user.unitId,
  });

  if (!row) {
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

  // Wrap both the atomic row update and the aggregate recompute in a
  // Serializable transaction to prevent duplicate guard notifications
  // when two residents approve concurrently for a multi-villa visitor.
  const runDecisionTx = async () =>
    prisma.$transaction(
      async (tx) => {
        const upd = await tx.visitorVilla.updateMany({
          where: {
            id: row.id,
            approvalStatus: VisitorVillaApprovalStatus.PENDING,
          },
          data: {
            approvalStatus: target,
            respondedAt: new Date(),
            respondedByUserId: params.userId,
          },
        });

        if (upd.count === 0) {
          return { updated: upd, hydrated: null, transitioned: false };
        }

        const result = await recomputeVisitorAggregateApproval(
          tx,
          params.visitorId,
          params.societyId,
        );

        return { updated: upd, hydrated: result.visitor, transitioned: result.transitioned };
      },
      { isolationLevel: "Serializable" },
    );

  let updated: { count: number };
  let hydrated: Awaited<ReturnType<typeof recomputeVisitorAggregateApproval>>["visitor"] | null;
  let transitioned: boolean;
  try {
    ({ updated, hydrated, transitioned } = await runDecisionTx());
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      ({ updated, hydrated, transitioned } = await runDecisionTx());
    } else {
      throw error;
    }
  }

  if (updated.count === 0) {
    return { status: 409 as const, body: { message: "Already responded" } };
  }

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

  if (
    transitioned &&
    hydrated &&
    (hydrated.status === VISITOR_APPROVED_FOR_ENTRY ||
      hydrated.status === VISITOR_REJECTED)
  ) {
    void notifyGuardsVisitorApprovalOutcome({
      prisma,
      societyId: params.societyId,
      visitorId: params.visitorId,
      visitorName: hydrated.name,
      outcome:
        hydrated.status === VISITOR_APPROVED_FOR_ENTRY ? "APPROVED" : "REJECTED",
      createdByGuardId: hydrated.createdBy,
    });

    // Multi-flat closure: tell the visitor's OTHER villa residents the request
    // is resolved (so their pending card doesn't silently vanish). Excludes the
    // resident who just acted. No-ops for a single-flat visitor with no others.
    void notifyResidentsVisitorApprovalResolved({
      prisma,
      societyId: params.societyId,
      visitorId: params.visitorId,
      visitorName: hydrated.name,
      villaIds: hydrated.villaVisits.map((vv) => vv.villaId),
      outcome:
        hydrated.status === VISITOR_APPROVED_FOR_ENTRY ? "APPROVED" : "REJECTED",
      excludeUserId: params.userId,
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
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
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
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
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

// POST /api/residents/visitors/:visitorId/wrong-entry — report unexpected / wrong-flat check-in
router.post(
  "/visitors/:visitorId/wrong-entry",
  wrongEntryRateLimiter,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  validateBody(wrongEntryReportSchema),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { visitorId } = req.params;
      const { reason, residentNote } = req.body as z.infer<typeof wrongEntryReportSchema>;

      const user = await prisma.user.findFirst({
        where: { id: userId, societyId },
        select: { villaId: true, unitId: true, name: true },
      });
      if (!user?.villaId) {
        return res.status(404).json({ message: "Villa not assigned" });
      }

      const visitMatch = {
        villaId: user.villaId,
        ...(user.unitId ? { unitId: user.unitId } : {}),
      };

      const visitor = await prisma.visitor.findFirst({
        where: {
          id: visitorId,
          societyId,
          villaVisits: { some: visitMatch },
        },
        include: {
          villaVisits: {
            where: visitMatch,
            select: {
              villa: { select: { villaNumber: true, block: true } },
            },
          },
        },
      });

      if (!visitor) {
        return res.status(404).json({ message: "Visitor not found" });
      }

      const existing = await prisma.visitorWrongEntryReport.findUnique({
        where: {
          visitorId_reportedByUserId: {
            visitorId: visitor.id,
            reportedByUserId: userId,
          },
        },
      });
      if (existing) {
        return res.status(409).json({
          message: "You already reported this visitor",
          report: existing,
        });
      }

      const report = await prisma.visitorWrongEntryReport.create({
        data: {
          societyId,
          visitorId: visitor.id,
          reportedByUserId: userId,
          reason,
          residentNote: residentNote?.trim() ? residentNote.trim() : null,
        },
      });

      const flatLabel = visitor.villaVisits
        .map((v) => [v.villa.block, v.villa.villaNumber].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(", ");

      const payload = {
        title: "Wrong entry reported",
        body: `${user.name || "Resident"} flagged ${visitor.name}${flatLabel ? ` at ${flatLabel}` : ""}: ${reason}`,
        data: {
          type: "VISITOR_WRONG_ENTRY",
          visitorId: visitor.id,
          reportId: report.id,
          visitorName: visitor.name,
        },
      };

      try {
        await notifySocietyRoles({
          societyId,
          roles: [UserRole.GUARD, UserRole.ADMIN],
          title: payload.title,
          body: payload.body,
          data: payload.data,
          category: NotificationCategory.VISITOR,
        });

        if (visitor.checkedInByGuardId) {
          await notifyUsers([visitor.checkedInByGuardId], payload, {
            category: NotificationCategory.VISITOR,
          });
        }
      } catch (err) {
        logger.error({ err, visitorId: visitor.id, reportId: report.id }, "[wrong-entry] notify failed");
      }

      return res.status(201).json({
        report,
        visitor: enrichVisitorForResident({
          ...visitor,
          wrongEntryReports: [
            { id: report.id, status: report.status, createdAt: report.createdAt },
          ],
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
