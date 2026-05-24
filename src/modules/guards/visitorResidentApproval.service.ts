import {
  NotificationCategory,
  UserRole,
  VisitorStatus,
  VisitorMultiVillaApprovalMode,
  VisitorVillaApprovalStatus,
} from "@prisma/client";
import type { Prisma, PrismaClient } from "@prisma/client";
import { NotificationService } from "../../services/notification.service";
import { logger } from "../../lib/logger";

/** Waiting at gate for resident decision(s). */
export const VISITOR_PENDING_APPROVAL = VisitorStatus.PENDING_APPROVAL;
/** Resident(s) approved — guard may complete physical entry. */
export const VISITOR_APPROVED_FOR_ENTRY = VisitorStatus.APPROVED;
export const VISITOR_REJECTED = VisitorStatus.DENIED;

const visitorWithVillas = {
  villaVisits: {
    include: {
      villa: { select: { id: true, villaNumber: true, block: true } },
      unit: { select: { id: true, unitCode: true, label: true } },
      resident: { select: { id: true, name: true, residentType: true } },
    },
  },
  gate: { select: { id: true, name: true } },
} as const;

export type VisitorApprovalTarget = {
  villaId: string;
  unitId?: string | null;
  residentUserId?: string | null;
};

/** Resolve who would receive an approval request (no notifications). */
export async function resolveVisitorApprovalRecipientIds(params: {
  prisma: PrismaClient;
  societyId: string;
  villaIds: string[];
  targets?: VisitorApprovalTarget[];
}): Promise<string[]> {
  if (params.targets && params.targets.length > 0) {
    const ids = new Set<string>();
    for (const t of params.targets) {
      if (t.residentUserId) {
        const u = await params.prisma.user.findFirst({
          where: {
            id: t.residentUserId,
            societyId: params.societyId,
            role: UserRole.RESIDENT,
            isActive: true,
            villaId: t.villaId,
          },
          select: { id: true },
        });
        if (u) ids.add(u.id);
        continue;
      }
      if (t.unitId) {
        const list = await params.prisma.user.findMany({
          where: {
            societyId: params.societyId,
            role: UserRole.RESIDENT,
            isActive: true,
            villaId: t.villaId,
            unitId: t.unitId,
          },
          select: { id: true },
        });
        for (const x of list) ids.add(x.id);
        continue;
      }
      const list = await params.prisma.user.findMany({
        where: {
          societyId: params.societyId,
          role: UserRole.RESIDENT,
          isActive: true,
          villaId: t.villaId,
        },
        select: { id: true },
      });
      for (const x of list) ids.add(x.id);
    }
    return [...ids];
  }
  const residents = await params.prisma.user.findMany({
    where: {
      societyId: params.societyId,
      role: UserRole.RESIDENT,
      isActive: true,
      villaId: { in: params.villaIds },
    },
    select: { id: true },
    distinct: ["id"],
  });
  return residents.map((r) => r.id);
}

export type VisitorForApprovalPayload = Prisma.VisitorGetPayload<{
  include: typeof visitorWithVillas;
}>;

const VISITOR_TYPE_LABEL: Record<string, string> = {
  GUEST: "Guest",
  DELIVERY: "Delivery",
  SERVICE_PROVIDER: "Service provider",
  VENDOR: "Vendor",
};

/** FCM rich image only supports https URLs (not data: URLs). */
function httpsPhotoForPush(photo: string | undefined | null): string | undefined {
  const p = photo?.trim();
  if (!p) return undefined;
  if (p.startsWith("https://")) return p;
  if (p.startsWith("http://")) return p;
  return undefined;
}

export async function notifyResidentsVisitorApprovalRequest(params: {
  prisma: PrismaClient;
  societyId: string;
  visitorId: string;
  visitorName: string;
  purpose: string;
  villaIds: string[];
  targets?: VisitorApprovalTarget[];
  guardUserId: string;
  visitorType: string;
  visitorPhone?: string;
  visitorPhoto?: string | null;
}): Promise<{ recipientUserCount: number }> {
  const guard = await params.prisma.user.findUnique({
    where: { id: params.guardUserId },
    select: { name: true },
  });
  const guardName = guard?.name?.trim() || "Security";

  const recipientIds = await resolveVisitorApprovalRecipientIds({
    prisma: params.prisma,
    societyId: params.societyId,
    villaIds: params.villaIds,
    targets: params.targets,
  });
  const residents = recipientIds.map((id) => ({ id }));

  const when = new Date().toISOString();
  const purposeLine = params.purpose?.trim() || "Visit";
  const typeKey = (params.visitorType || "GUEST").trim();
  const typeLabel = VISITOR_TYPE_LABEL[typeKey] ?? typeKey;
  const title = `Visitor: ${params.visitorName}`;
  const body = `${typeLabel} · ${purposeLine}`;

  const imageUrl = httpsPhotoForPush(params.visitorPhoto ?? undefined);

  const data: Record<string, string> = {
    type: "VISITOR_APPROVAL_REQUEST",
    visitorId: params.visitorId,
    visitorName: params.visitorName,
    purpose: purposeLine,
    visitorType: typeKey,
    visitorTypeLabel: typeLabel,
    guardName,
    time: when,
  };
  if (params.visitorPhone?.trim()) {
    data.visitorPhone = params.visitorPhone.trim();
  }
  if (params.visitorPhoto?.trim()) {
    data.photoUrl = params.visitorPhoto.trim();
  }
  if (imageUrl) {
    data.imageUrl = imageUrl;
  }

  const pushPayload = {
    title,
    body,
    data,
    ...(imageUrl ? { imageUrl } : {}),
  };

  logger.info({
    visitorId: params.visitorId,
    villaCount: params.villaIds.length,
    residentUserCount: residents.length,
    type: data.type,
  }, "notifyResidentsVisitorApprovalRequest");

  const results = await Promise.allSettled(
    residents.map((r) =>
      NotificationService.sendToUser(r.id, pushPayload, { category: NotificationCategory.VISITOR }),
    ),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      logger.error({ err: r.reason }, "notifyResidentsVisitorApprovalRequest send failed");
    }
  }
  return { recipientUserCount: residents.length };
}

export async function notifyGuardsVisitorApprovalOutcome(params: {
  prisma: PrismaClient;
  societyId: string;
  visitorId: string;
  visitorName: string;
  outcome: "APPROVED" | "REJECTED";
  /** Guard who checked this visitor in (`Visitor.createdBy`) — they get the push first; falls back to all guards if unset/invalid */
  createdByGuardId?: string | null;
}): Promise<void> {
  const title =
    params.outcome === "APPROVED" ? "Visitor approved" : "Visitor rejected";
  const body =
    params.outcome === "APPROVED"
      ? `${params.visitorName} — residents approved entry. Admit when ready.`
      : `${params.visitorName} — entry was rejected by a resident.`;

  const data: Record<string, string> = {
    type: "VISITOR_APPROVAL_RESOLVED",
    visitorId: params.visitorId,
    outcome: params.outcome,
    societyId: params.societyId,
  };

  const guardIds: string[] = [];
  if (params.createdByGuardId) {
    const creator = await params.prisma.user.findFirst({
      where: {
        id: params.createdByGuardId,
        societyId: params.societyId,
        role: UserRole.GUARD,
        isActive: true,
      },
      select: { id: true },
    });
    if (creator) {
      guardIds.push(creator.id);
    }
  }

  if (guardIds.length === 0) {
    const guards = await params.prisma.user.findMany({
      where: { societyId: params.societyId, role: UserRole.GUARD, isActive: true },
      select: { id: true },
    });
    guardIds.push(...guards.map((g) => g.id));
  }

  const uniqueGuardIds = [...new Set(guardIds)];

  logger.info({
    visitorId: params.visitorId,
    outcome: params.outcome,
    createdByGuardId: params.createdByGuardId ?? null,
    guardUserCount: uniqueGuardIds.length,
  }, "notifyGuardsVisitorApprovalOutcome");

  const guardResults = await Promise.allSettled(
    uniqueGuardIds.map((id) =>
      NotificationService.sendToUser(id, { title, body, data }, { category: NotificationCategory.VISITOR }),
    ),
  );
  for (const r of guardResults) {
    if (r.status === "rejected") {
      logger.error({ err: r.reason }, "notifyGuardsVisitorApprovalOutcome send failed");
    }
  }
}

/**
 * Multi-flat visitor still pending overall — one flat already approved/rejected.
 * Notifies only the guard who checked the visitor in.
 */
export async function notifyCreatingGuardVisitorVillaProgress(params: {
  prisma: PrismaClient;
  societyId: string;
  guardUserId: string;
  visitorId: string;
  visitorName: string;
  decision: "APPROVE" | "REJECT";
  villaLabel: string;
}): Promise<void> {
  try {
    const guard = await params.prisma.user.findFirst({
      where: {
        id: params.guardUserId,
        societyId: params.societyId,
        role: UserRole.GUARD,
        isActive: true,
      },
      select: { id: true },
    });
    if (!guard) {
      return;
    }

    const verb = params.decision === "APPROVE" ? "Approved" : "Rejected";
    const title = `Visitor update: ${params.visitorName}`;
    const body = `${verb} for ${params.villaLabel}. Other flats may still need to respond.`;

    const data: Record<string, string> = {
      type: "VISITOR_VILLA_RESPONSE",
      visitorId: params.visitorId,
      decision: params.decision,
      societyId: params.societyId,
    };

    await NotificationService.sendToUser(
      guard.id,
      { title, body, data },
      { category: NotificationCategory.VISITOR },
    );
  } catch (e) {
    logger.error({ err: e }, "notifyCreatingGuardVisitorVillaProgress failed");
  }
}

/** Resident added / refreshed society pre-approval — ping all active guards (push + in-app). */
export async function notifyGuardsPreApprovedCreated(params: {
  prisma: PrismaClient;
  societyId: string;
  preApprovedId: string;
  visitorName: string;
  visitorPhone: string;
  villa?: { villaNumber: string | null; block: string | null } | null;
}): Promise<void> {
  const guards = await params.prisma.user.findMany({
    where: { societyId: params.societyId, role: UserRole.GUARD, isActive: true },
    select: { id: true },
  });

  const villa = params.villa;
  const flatParts = [villa?.block, villa?.villaNumber].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  const flatLabel = flatParts.length > 0 ? flatParts.join(" · ") : "";
  const title = "Expected visitor";
  const body = flatLabel
    ? `${params.visitorName} (${flatLabel}) — added by a resident. Open Expected visitors.`
    : `${params.visitorName} — added by a resident. Open Expected visitors.`;

  const data: Record<string, string> = {
    type: "VISITOR_PRE_APPROVED_CREATED",
    preApprovedId: params.preApprovedId,
    name: params.visitorName,
    phone: params.visitorPhone,
  };

  logger.info({
    societyId: params.societyId,
    preApprovedId: params.preApprovedId,
    guardUserCount: guards.length,
  }, "notifyGuardsPreApprovedCreated");

  const guardResults = await Promise.allSettled(
    guards.map((g) =>
      NotificationService.sendToUser(g.id, { title, body, data }, { category: NotificationCategory.VISITOR }),
    ),
  );
  for (const r of guardResults) {
    if (r.status === "rejected") {
      logger.error({ err: r.reason }, "notifyGuardsPreApprovedCreated send failed");
    }
  }
}

/**
 * After a villa row is updated, aggregate visitor status (idempotent).
 * Returns updated visitor when status changes to APPROVED or REJECTED.
 */
export async function recomputeVisitorAggregateApproval(
  prisma: PrismaClient,
  visitorId: string,
  societyId: string,
): Promise<{
  previousStatus: string;
  visitor: VisitorForApprovalPayload | null;
  transitioned: boolean;
}> {
  const visitor = await prisma.visitor.findFirst({
    where: { id: visitorId, societyId },
    include: {
      villaVisits: true,
      society: { select: { visitorMultiVillaApprovalMode: true } },
    },
  });

  if (!visitor) {
    return { previousStatus: "", visitor: null, transitioned: false };
  }

  const prev = visitor.status;

  if (prev !== VISITOR_PENDING_APPROVAL) {
    const hydrated = await prisma.visitor.findUnique({
      where: { id: visitorId },
      include: visitorWithVillas,
    });
    return { previousStatus: prev, visitor: hydrated, transitioned: false };
  }

  const mode: VisitorMultiVillaApprovalMode = visitor.society.visitorMultiVillaApprovalMode;
  const rows = visitor.villaVisits;

  const anyApproved = rows.some((r) => r.approvalStatus === VisitorVillaApprovalStatus.APPROVED);
  const anyRejected = rows.some((r) => r.approvalStatus === VisitorVillaApprovalStatus.REJECTED);
  const allApproved =
    rows.length > 0 && rows.every((r) => r.approvalStatus === VisitorVillaApprovalStatus.APPROVED);
  const nonePending = rows.every((r) => r.approvalStatus !== VisitorVillaApprovalStatus.PENDING);

  let next: VisitorStatus | null = null;
  if (mode === VisitorMultiVillaApprovalMode.ANY_ONE_APPROVAL) {
    if (anyApproved) next = VISITOR_APPROVED_FOR_ENTRY;
    else if (nonePending && !anyApproved) next = VISITOR_REJECTED;
  } else {
    if (anyRejected) next = VISITOR_REJECTED;
    else if (allApproved) next = VISITOR_APPROVED_FOR_ENTRY;
  }

  if (!next) {
    const hydrated = await prisma.visitor.findUnique({
      where: { id: visitorId },
      include: visitorWithVillas,
    });
    return { previousStatus: prev, visitor: hydrated, transitioned: false };
  }

  await prisma.visitor.update({
    where: { id: visitorId },
    data: { status: next },
  });

  const hydrated = await prisma.visitor.findUnique({
    where: { id: visitorId },
    include: visitorWithVillas,
  });

  const transitioned = prev === VISITOR_PENDING_APPROVAL && next !== null;

  if (transitioned && (next === VISITOR_APPROVED_FOR_ENTRY || next === VISITOR_REJECTED)) {
    await notifyGuardsVisitorApprovalOutcome({
      prisma,
      societyId,
      visitorId,
      visitorName: visitor.name,
      outcome: next === VISITOR_APPROVED_FOR_ENTRY ? "APPROVED" : "REJECTED",
      createdByGuardId: visitor.createdBy,
    });
  }

  return {
    previousStatus: prev,
    visitor: hydrated,
    transitioned,
  };
}
