import {
  NotificationCategory,
  Prisma,
  Visitor,
  VisitorStatus,
  VisitorVilla,
  VisitorMultiVillaApprovalMode,
  VisitorVillaApprovalStatus,
  PreApprovedVisitor,
} from "@prisma/client";
import { logger } from "../../lib/logger";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import { notifyUsers } from "../../services/notification.service";

/**
 * CENTRALIZED VISITOR STATE MANAGER
 * 
 * Single source of truth for ALL visitor lifecycle operations.
 * Replaces distributed logic across 6 files with unified state machine.
 * 
 * Key Features:
 * - Atomic state transitions with validation
 * - Multi-villa approval aggregation (race-safe)
 * - Unified notification routing
 * - Complete audit trail
 * - OTP/QR pre-approved flow
 */

// ============================================================================
// TYPES & ENUMS
// ============================================================================

export enum VisitorTransitionType {
  GUARD_CHECKIN = "GUARD_CHECKIN",           // Walk-in at gate (pending approval)
  RESIDENT_APPROVE = "RESIDENT_APPROVE",     // Resident approves via app
  RESIDENT_REJECT = "RESIDENT_REJECT",       // Resident rejects
  OTP_SCAN = "OTP_SCAN",                     // Guard scans pre-approved OTP
  QR_SCAN = "QR_SCAN",                       // Guard scans QR code
  PRE_APPROVED_ADMIT = "PRE_APPROVED_ADMIT", // Guard admits from pre-approved list
  GUARD_ADMIT = "GUARD_ADMIT",               // Final entry after approval
  GUARD_CHECKOUT = "GUARD_CHECKOUT",         // Visitor exits
  AUTO_CHECKOUT = "AUTO_CHECKOUT",           // Cron-based timeout checkout
  EMERGENCY_OVERRIDE = "EMERGENCY_OVERRIDE", // Admin forces entry
}

export enum VisitorCheckpointType {
  ENTRY_REQUESTED = "ENTRY_REQUESTED",
  APPROVAL_PENDING = "APPROVAL_PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  ADMITTED = "ADMITTED",
  EXITED = "EXITED",
  EMERGENCY_OVERRIDE = "EMERGENCY_OVERRIDE",
}

export interface VisitorStateTransition {
  visitorId: string;
  fromStatus: VisitorStatus | null; // null for creation
  toStatus: VisitorStatus;
  transitionType: VisitorTransitionType;
  actorUserId: string;
  societyId: string;
  timestamp: Date;
  metadata?: {
    gateName?: string;
    guardName?: string;
    rejectionReason?: string;
    otpCode?: string;
    preApprovedId?: string;
    overrideReason?: string;
    villaId?: string;
    unitId?: string;
  };
}

export interface VisitorApprovalTarget {
  villaId: string;
  unitId?: string | null;
  residentUserId?: string | null;
}

export interface PreApprovedAdmitParams {
  preApprovedId?: string;
  otpCode?: string;
  qrData?: string;
  gateId: string;
  guardUserId: string;
  societyId: string;
}

// ============================================================================
// STATE MACHINE VALIDATION
// ============================================================================

/** Legal state transitions matrix. */
const VALID_VISITOR_TRANSITIONS: Record<
  VisitorStatus,
  Partial<Record<VisitorTransitionType, VisitorStatus[]>>
> = {
  [VisitorStatus.PENDING_APPROVAL]: {
    [VisitorTransitionType.RESIDENT_APPROVE]: [VisitorStatus.APPROVED],
    [VisitorTransitionType.RESIDENT_REJECT]: [VisitorStatus.DENIED],
    [VisitorTransitionType.EMERGENCY_OVERRIDE]: [VisitorStatus.CHECKED_IN],
    [VisitorTransitionType.GUARD_ADMIT]: [VisitorStatus.CHECKED_IN], // If approval complete
  },
  [VisitorStatus.APPROVED]: {
    [VisitorTransitionType.GUARD_ADMIT]: [VisitorStatus.CHECKED_IN],
    [VisitorTransitionType.EMERGENCY_OVERRIDE]: [VisitorStatus.CHECKED_IN],
  },
  [VisitorStatus.CHECKED_IN]: {
    [VisitorTransitionType.GUARD_CHECKOUT]: [VisitorStatus.CHECKED_OUT],
    [VisitorTransitionType.AUTO_CHECKOUT]: [VisitorStatus.CHECKED_OUT],
  },
  [VisitorStatus.DENIED]: {
    [VisitorTransitionType.EMERGENCY_OVERRIDE]: [VisitorStatus.CHECKED_IN],
  },
  [VisitorStatus.CHECKED_OUT]: {},
  [VisitorStatus.CANCELLED]: {}, // Terminal state, no transitions
};

function validateTransition(transition: VisitorStateTransition): void {
  if (transition.fromStatus === null) {
    // New visitor creation, no validation needed
    return;
  }

  const allowedTransitions = VALID_VISITOR_TRANSITIONS[transition.fromStatus];
  if (!allowedTransitions) {
    throw new Error(
      `INVALID_STATE: No transitions defined for status ${transition.fromStatus}`
    );
  }

  const allowedTargetStates = allowedTransitions[transition.transitionType];
  if (!allowedTargetStates || !allowedTargetStates.includes(transition.toStatus)) {
    throw new Error(
      `INVALID_TRANSITION: Cannot transition from ${transition.fromStatus} to ${transition.toStatus} via ${transition.transitionType}`
    );
  }
}

function mapTransitionToCheckpointType(
  transitionType: VisitorTransitionType
): VisitorCheckpointType {
  const mapping: Record<VisitorTransitionType, VisitorCheckpointType> = {
    [VisitorTransitionType.GUARD_CHECKIN]: VisitorCheckpointType.ENTRY_REQUESTED,
    [VisitorTransitionType.RESIDENT_APPROVE]: VisitorCheckpointType.APPROVED,
    [VisitorTransitionType.RESIDENT_REJECT]: VisitorCheckpointType.REJECTED,
    [VisitorTransitionType.OTP_SCAN]: VisitorCheckpointType.ADMITTED,
    [VisitorTransitionType.QR_SCAN]: VisitorCheckpointType.ADMITTED,
    [VisitorTransitionType.PRE_APPROVED_ADMIT]: VisitorCheckpointType.ADMITTED,
    [VisitorTransitionType.GUARD_ADMIT]: VisitorCheckpointType.ADMITTED,
    [VisitorTransitionType.GUARD_CHECKOUT]: VisitorCheckpointType.EXITED,
    [VisitorTransitionType.AUTO_CHECKOUT]: VisitorCheckpointType.EXITED,
    [VisitorTransitionType.EMERGENCY_OVERRIDE]: VisitorCheckpointType.EMERGENCY_OVERRIDE,
  };
  return mapping[transitionType];
}

// ============================================================================
// AUDIT TRAIL
// ============================================================================

async function recordVisitorCheckpoint(
  tx: Prisma.TransactionClient,
  params: {
    visitorId: string;
    checkpointType: VisitorCheckpointType;
    timestamp: Date;
    actorUserId: string;
    metadata?: Record<string, any>;
  }
): Promise<void> {
  await tx.visitorCheckpoint.create({
    data: {
      visitorId: params.visitorId,
      checkpointType: params.checkpointType,
      timestamp: params.timestamp,
      actorUserId: params.actorUserId,
      metadata: params.metadata || {},
    },
  });

  logger.info(
    {
      visitorId: params.visitorId,
      checkpointType: params.checkpointType,
      actorUserId: params.actorUserId,
    },
    "[visitor-checkpoint] Recorded"
  );
}

// ============================================================================
// NOTIFICATION ROUTING
// ============================================================================

async function sendVisitorNotifications(
  tx: Prisma.TransactionClient,
  params: {
    visitor: Visitor & { villaVisits?: VisitorVilla[] };
    transition: Partial<VisitorStateTransition>;
  }
): Promise<number> {
  const { visitor, transition } = params;
  let notificationsSent = 0;

  try {
    // Get villa residents for notifications
    const villaIdsFromVisits =
      visitor.villaVisits?.map((vv) => vv.villaId) ||
      (await tx.visitorVilla
        .findMany({
          where: { visitorId: visitor.id },
          select: { villaId: true },
        })
        .then((villas) => villas.map((v) => v.villaId))) ||
      [];

    if (villaIdsFromVisits.length === 0) return 0;

    const residents = await tx.user.findMany({
      where: {
        societyId: visitor.societyId,
        villaId: { in: villaIdsFromVisits },
        ...residentLikeRoleFilter,
        isActive: true,
      },
      select: { id: true },
      distinct: ["id"],
    });

    if (residents.length === 0) return 0;

    // Notification content based on transition type
    let title = "Visitor Update";
    let body = `${visitor.name} - Status updated`;
    let notificationType = "VISITOR_UPDATE";

    switch (transition.transitionType) {
      case VisitorTransitionType.GUARD_CHECKIN:
        title = "Visitor Approval Request";
        body = `${visitor.name} is at the gate. Approve entry?`;
        notificationType = "VISITOR_APPROVAL_REQUEST";
        break;

      case VisitorTransitionType.RESIDENT_APPROVE:
        // Don't notify on approve (guard will handle final admit notification)
        return 0;

      case VisitorTransitionType.RESIDENT_REJECT:
        title = "Visitor Entry Denied";
        body = `Entry denied for ${visitor.name}`;
        notificationType = "VISITOR_REJECTED";
        break;

      case VisitorTransitionType.OTP_SCAN:
      case VisitorTransitionType.QR_SCAN:
      case VisitorTransitionType.PRE_APPROVED_ADMIT:
        title = "Pre-Approved Visitor Arrived";
        body = `${visitor.name} has checked in`;
        notificationType = "VISITOR_PRE_APPROVED_ARRIVED";
        break;

      case VisitorTransitionType.GUARD_ADMIT:
        title = "Visitor Checked In";
        body = `${visitor.name} has entered`;
        notificationType = "VISITOR_CHECKED_IN";
        break;

      case VisitorTransitionType.GUARD_CHECKOUT:
      case VisitorTransitionType.AUTO_CHECKOUT:
        title = "Visitor Checked Out";
        body = `${visitor.name} has left`;
        notificationType = "VISITOR_CHECKED_OUT";
        break;

      case VisitorTransitionType.EMERGENCY_OVERRIDE:
        title = "Visitor Entry - Admin Override";
        body = `${visitor.name} admitted by admin`;
        notificationType = "VISITOR_EMERGENCY_OVERRIDE";
        break;
    }

    await notifyUsers(
      residents.map((r) => r.id),
      {
        title,
        body,
        data: {
          type: notificationType,
          visitorId: visitor.id,
          visitorName: visitor.name,
          visitorStatus: visitor.status,
        },
      },
      { category: NotificationCategory.VISITOR }
    );

    notificationsSent = residents.length;
  } catch (err) {
    logger.error({ err, visitorId: visitor.id }, "[visitor-notifications] Failed to send");
    // Don't throw - notifications are fire-and-forget
  }

  return notificationsSent;
}

// ============================================================================
// CORE STATE MACHINE
// ============================================================================

/**
 * Central state machine for ALL visitor flows.
 * Validates transitions, updates visitor status, creates audit trail, sends notifications.
 */
export async function transitionVisitorState(
  tx: Prisma.TransactionClient,
  transition: VisitorStateTransition
): Promise<{ visitor: Visitor; notificationsSent: number }> {
  logger.info(
    {
      visitorId: transition.visitorId,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      transitionType: transition.transitionType,
    },
    "[visitor-state] Transitioning"
  );

  // 1. Validate transition is legal
  validateTransition(transition);

  // 2. Update Visitor status atomically
  const visitor = await tx.visitor.update({
    where: { id: transition.visitorId },
    data: {
      status: transition.toStatus,
      updatedAt: transition.timestamp,
      // Set timestamps based on status
      ...(transition.toStatus === VisitorStatus.CHECKED_IN && { checkInAt: transition.timestamp }),
      ...(transition.toStatus === VisitorStatus.CHECKED_OUT && { checkOutAt: transition.timestamp }),
    },
    include: {
      villaVisits: {
        include: {
          villa: { select: { villaNumber: true, block: true } },
          unit: { select: { unitCode: true } },
        },
      },
    },
  });

  // 3. Create audit checkpoint
  await recordVisitorCheckpoint(tx, {
    visitorId: transition.visitorId,
    checkpointType: mapTransitionToCheckpointType(transition.transitionType),
    timestamp: transition.timestamp,
    actorUserId: transition.actorUserId,
    metadata: transition.metadata,
  });

  // 4. Send notifications (centralized routing)
  const notificationCount = await sendVisitorNotifications(tx, {
    visitor,
    transition,
  });

  logger.info(
    {
      visitorId: visitor.id,
      newStatus: visitor.status,
      notificationsSent: notificationCount,
    },
    "[visitor-state] Transition complete"
  );

  return { visitor, notificationsSent: notificationCount };
}

// ============================================================================
// MULTI-VILLA APPROVAL AGGREGATION (Race-Safe)
// ============================================================================

/**
 * Recompute aggregate visitor status across multi-villa approvals.
 * Uses transaction isolation to prevent race conditions.
 * 
 * Respects society's `visitorMultiVillaApprovalMode`:
 * - ANY_ONE_APPROVAL: Any villa can approve
 * - ALL_MUST_APPROVE: All villas must approve
 */
export async function recomputeVisitorAggregateApproval(
  tx: Prisma.TransactionClient,
  params: {
    visitorId: string;
    societyId: string;
  }
): Promise<VisitorStatus> {
  logger.info({ visitorId: params.visitorId }, "[visitor-approval] Recomputing aggregate");

  // Get society approval mode
  const society = await tx.society.findUnique({
    where: { id: params.societyId },
    select: { visitorMultiVillaApprovalMode: true },
  });

  if (!society) {
    throw new Error("SOCIETY_NOT_FOUND");
  }

  // Get all villa visits with approval status
  const villaVisits = await tx.visitorVilla.findMany({
    where: { visitorId: params.visitorId },
    select: { approvalStatus: true, villaId: true },
  });

  if (villaVisits.length === 0) {
    logger.warn({ visitorId: params.visitorId }, "[visitor-approval] No villa visits found");
    return VisitorStatus.PENDING_APPROVAL;
  }

  let aggregateStatus: VisitorStatus;

  if (society.visitorMultiVillaApprovalMode === VisitorMultiVillaApprovalMode.ANY_ONE_APPROVAL) {
    // ANY villa approval is sufficient
    const hasApproved = villaVisits.some((vv) => vv.approvalStatus === VisitorVillaApprovalStatus.APPROVED);
    const allDenied = villaVisits.every((vv) => vv.approvalStatus === VisitorVillaApprovalStatus.REJECTED);

    aggregateStatus = hasApproved
      ? VisitorStatus.APPROVED
      : allDenied
      ? VisitorStatus.DENIED
      : VisitorStatus.PENDING_APPROVAL;
  } else {
    // ALL villas must approve
    const allApproved = villaVisits.every((vv) => vv.approvalStatus === VisitorVillaApprovalStatus.APPROVED);
    const anyDenied = villaVisits.some((vv) => vv.approvalStatus === VisitorVillaApprovalStatus.REJECTED);

    aggregateStatus = allApproved
      ? VisitorStatus.APPROVED
      : anyDenied
      ? VisitorStatus.DENIED
      : VisitorStatus.PENDING_APPROVAL;
  }

  // Update visitor status
  await tx.visitor.update({
    where: { id: params.visitorId },
    data: { status: aggregateStatus },
  });

  logger.info(
    {
      visitorId: params.visitorId,
      aggregateStatus,
      mode: society.visitorMultiVillaApprovalMode,
      villaCount: villaVisits.length,
    },
    "[visitor-approval] Aggregate computed"
  );

  return aggregateStatus;
}

// ============================================================================
// PRE-APPROVED VISITOR ADMISSION (OTP/QR Flow)
// ============================================================================

/**
 * Atomic OTP/QR scan flow: pre-approved → visitor conversion.
 * Creates Visitor + VisitorVilla in single transaction.
 * Skips approval phase (pre-approved visitors are auto-admitted).
 */
export async function admitPreApprovedVisitor(
  tx: Prisma.TransactionClient,
  params: PreApprovedAdmitParams
): Promise<{ visitor: Visitor; preApproved: PreApprovedVisitor }> {
  logger.info(
    {
      preApprovedId: params.preApprovedId,
      otpCode: params.otpCode ? "***" : undefined,
      guardUserId: params.guardUserId,
    },
    "[visitor-pre-approved] Admitting"
  );

  // 1. Find pre-approval by ID, OTP, or QR code
  const whereClause: Prisma.PreApprovedVisitorWhereInput = {
    societyId: params.societyId,
    isActive: true,
  };

  if (params.preApprovedId) {
    whereClause.id = params.preApprovedId;
  } else if (params.otpCode) {
    whereClause.otp = params.otpCode;
  } else {
    throw new Error("PRE_APPROVED_IDENTIFIER_REQUIRED");
  }

  const preApproved = await tx.preApprovedVisitor.findFirst({
    where: whereClause,
    include: {
      villa: { select: { id: true, villaNumber: true, block: true } },
    },
  });

  if (!preApproved) {
    throw new Error("PRE_APPROVED_NOT_FOUND");
  }

  // Check if already used (for single-use)
  if (!preApproved.isRecurring && preApproved.isUsed) {
    throw new Error("PRE_APPROVED_EXHAUSTED");
  }

  // Check if recurring has reached max uses
  if (preApproved.isRecurring && preApproved.maxUses && preApproved.usedCount >= preApproved.maxUses) {
    throw new Error("PRE_APPROVED_EXHAUSTED");
  }

  // Check expiry
  if (preApproved.validUntil && new Date() > preApproved.validUntil) {
    throw new Error("PRE_APPROVED_EXPIRED");
  }

  // 2. Mark pre-approval as used
  if (preApproved.isRecurring) {
    await tx.preApprovedVisitor.update({
      where: { id: preApproved.id },
      data: {
        usedAt: new Date(),
        usedCount: { increment: 1 },
      },
    });
  } else {
    await tx.preApprovedVisitor.update({
      where: { id: preApproved.id },
      data: {
        isUsed: true,
        usedAt: new Date(),
        usedCount: { increment: 1 },
      },
    });
  }

  // 3. Create Visitor (auto-admitted, no approval phase)
  const visitor = await tx.visitor.create({
    data: {
      name: preApproved.name,
      phone: preApproved.phone,
      purpose: preApproved.purpose || "Pre-approved visit",
      visitorType: preApproved.visitorType,
      status: VisitorStatus.CHECKED_IN, // Skip approval
      societyId: params.societyId,
      gateId: params.gateId,
      checkInAt: new Date(),
      checkedInByGuardId: params.guardUserId,
    },
  });

  // 4. Create VisitorVilla (pre-approved) - get default unit
  const defaultUnit = await tx.unit.findFirst({
    where: {
      villaId: preApproved.villaId,
      societyId: params.societyId,
    },
    orderBy: { isDefault: "desc" },
  });

  if (!defaultUnit) {
    throw new Error("NO_UNIT_FOUND_FOR_VILLA");
  }

  await tx.visitorVilla.create({
    data: {
      visitorId: visitor.id,
      villaId: preApproved.villaId,
      unitId: defaultUnit.id,
      approvalStatus: "APPROVED" as VisitorVillaApprovalStatus,
    },
  });

  // 5. Record checkpoint
  await recordVisitorCheckpoint(tx, {
    visitorId: visitor.id,
    checkpointType: VisitorCheckpointType.ADMITTED,
    timestamp: new Date(),
    actorUserId: params.guardUserId,
    metadata: {
      preApprovedId: preApproved.id,
      otpUsed: !!params.otpCode,
      qrUsed: !!params.qrData,
    },
  });

  // 6. Notify villa residents (pre-approved arrival)
  await sendVisitorNotifications(tx, {
    visitor,
    transition: {
      transitionType: params.otpCode
        ? VisitorTransitionType.OTP_SCAN
        : params.qrData
        ? VisitorTransitionType.QR_SCAN
        : VisitorTransitionType.PRE_APPROVED_ADMIT,
    },
  });

  logger.info(
    {
      visitorId: visitor.id,
      preApprovedId: preApproved.id,
      villaId: preApproved.villaId,
    },
    "[visitor-pre-approved] Admitted successfully"
  );

  return { visitor, preApproved };
}

// ============================================================================
// HELPER: Resolve Approval Recipients
// ============================================================================

/**
 * Resolve user IDs who should receive visitor approval requests.
 * Respects targets (specific residents/units/villas).
 */
export async function resolveVisitorApprovalRecipientIds(params: {
  prisma: Prisma.TransactionClient;
  societyId: string;
  villaIds: string[];
  targets?: VisitorApprovalTarget[];
}): Promise<string[]> {
  if (params.targets && params.targets.length > 0) {
    const ids = new Set<string>();
    for (const t of params.targets) {
      // Specific resident
      if (t.residentUserId) {
        const u = await params.prisma.user.findFirst({
          where: {
            id: t.residentUserId,
            societyId: params.societyId,
            ...residentLikeRoleFilter,
            isActive: true,
            villaId: t.villaId,
          },
          select: { id: true },
        });
        if (u) ids.add(u.id);
        continue;
      }

      // Specific unit
      if (t.unitId) {
        const list = await params.prisma.user.findMany({
          where: {
            societyId: params.societyId,
            ...residentLikeRoleFilter,
            isActive: true,
            villaId: t.villaId,
            unitId: t.unitId,
          },
          select: { id: true },
        });
        for (const x of list) ids.add(x.id);
        continue;
      }

      // All residents of villa
      const list = await params.prisma.user.findMany({
        where: {
          societyId: params.societyId,
          ...residentLikeRoleFilter,
          isActive: true,
          villaId: t.villaId,
        },
        select: { id: true },
      });
      for (const x of list) ids.add(x.id);
    }
    return [...ids];
  }

  // No targets specified - notify all residents of all villas
  const residents = await params.prisma.user.findMany({
    where: {
      societyId: params.societyId,
      ...residentLikeRoleFilter,
      isActive: true,
      villaId: { in: params.villaIds },
    },
    select: { id: true },
    distinct: ["id"],
  });

  return residents.map((r) => r.id);
}
