/**
 * SOS Emergency Coordinator
 *
 * Centralized module for managing SOS alert lifecycle with:
 * - Explicit state machine with valid transitions
 * - Persistent escalation tracking (DB-backed, not in-memory timers)
 * - Atomic state changes with audit trail
 * - Centralized notification routing
 * - Race condition prevention
 *
 * Replaces distributed logic in:
 * - modules/sos-alerts/routes.ts
 * - services/sosLifecycle.service.ts
 * - modules/guards/routes.ts (SOS response)
 */

import {
  Prisma,
  SOSAlert,
  SOSStatus,
  SOSType,
  UserRole,
  NotificationCategory,
} from "@prisma/client";
import { logger } from "../lib/logger";
import { notifySocietyRoles, notifyUserIds } from "./notification.service";

// ============================================================================
// TYPES & ENUMS
// ============================================================================

/**
 * All possible SOS state transitions.
 * Maps to user actions (resident, guard, admin) and system events (escalation).
 */
export enum SOSTransitionType {
  // Resident actions
  CREATE = "CREATE",
  CANCEL = "CANCEL",

  // Guard/Admin actions
  ACKNOWLEDGE = "ACKNOWLEDGE",
  START_RESPONSE = "START_RESPONSE",
  RESOLVE = "RESOLVE",

  // System actions
  ESCALATE = "ESCALATE",
}

/**
 * Audit checkpoint types for SOS events.
 * Every state change creates one checkpoint.
 */
export enum SOSCheckpointType {
  CREATED = "CREATED",
  ACKNOWLEDGED = "ACKNOWLEDGED",
  IN_PROGRESS = "IN_PROGRESS",
  RESOLVED = "RESOLVED",
  CANCELLED = "CANCELLED",
  ESCALATED = "ESCALATED",
}

/**
 * Describes a single SOS state transition.
 */
export interface SOSStateTransition {
  alertId: string;
  fromStatus: SOSStatus;
  toStatus: SOSStatus;
  transitionType: SOSTransitionType;
  actorUserId?: string; // Guard/resident who performed action (null for system)
  societyId: string;
  timestamp: Date;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Parameters for creating a new SOS alert.
 */
export interface CreateSOSParams {
  societyId: string;
  villaId: string;
  triggeredBy: string;
  emergencyType: SOSType;
  message?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

/**
 * Valid state transitions matrix.
 * Enforces business rules at compile-time and runtime.
 */
const VALID_SOS_TRANSITIONS: Record<SOSStatus, Partial<Record<SOSStatus, SOSTransitionType[]>>> = {
  [SOSStatus.CREATED]: {
    [SOSStatus.ACKNOWLEDGED]: [SOSTransitionType.ACKNOWLEDGE],
    [SOSStatus.CANCELLED]: [SOSTransitionType.CANCEL],
    [SOSStatus.CREATED]: [SOSTransitionType.ESCALATE], // Re-notification
  },
  [SOSStatus.PENDING]: {
    // Legacy status from old mobile - treat like CREATED
    [SOSStatus.ACKNOWLEDGED]: [SOSTransitionType.ACKNOWLEDGE],
    [SOSStatus.CANCELLED]: [SOSTransitionType.CANCEL],
  },
  [SOSStatus.ACTIVE]: {
    // Legacy status from old mobile - treat like CREATED
    [SOSStatus.ACKNOWLEDGED]: [SOSTransitionType.ACKNOWLEDGE],
    [SOSStatus.CANCELLED]: [SOSTransitionType.CANCEL],
  },
  [SOSStatus.ACKNOWLEDGED]: {
    [SOSStatus.IN_PROGRESS]: [SOSTransitionType.START_RESPONSE],
    [SOSStatus.RESOLVED]: [SOSTransitionType.RESOLVE],
    [SOSStatus.CANCELLED]: [SOSTransitionType.CANCEL],
  },
  [SOSStatus.IN_PROGRESS]: {
    [SOSStatus.RESOLVED]: [SOSTransitionType.RESOLVE],
    [SOSStatus.CANCELLED]: [SOSTransitionType.CANCEL],
  },
  [SOSStatus.RESOLVED]: {},
  [SOSStatus.CANCELLED]: {},
};

/**
 * Statuses considered "open" (not terminal).
 */
export const OPEN_SOS_STATUSES: SOSStatus[] = [
  SOSStatus.CREATED,
  SOSStatus.ACTIVE,
  SOSStatus.PENDING,
  SOSStatus.ACKNOWLEDGED,
  SOSStatus.IN_PROGRESS,
];

// ============================================================================
// VALIDATION
// ============================================================================

function validateTransition(transition: SOSStateTransition): void {
  const allowedToStatuses = VALID_SOS_TRANSITIONS[transition.fromStatus];

  if (!allowedToStatuses) {
    throw new Error(
      `INVALID_SOS_TRANSITION: No transitions defined for status ${transition.fromStatus}`
    );
  }

  const allowedTypes = allowedToStatuses[transition.toStatus];
  if (!allowedTypes || !allowedTypes.includes(transition.transitionType)) {
    throw new Error(
      `INVALID_SOS_TRANSITION: Cannot transition from ${transition.fromStatus} to ${transition.toStatus} via ${transition.transitionType}`
    );
  }
}

// ============================================================================
// AUDIT TRAIL
// ============================================================================

function mapTransitionToCheckpointType(transitionType: SOSTransitionType): SOSCheckpointType {
  const mapping: Record<SOSTransitionType, SOSCheckpointType> = {
    [SOSTransitionType.CREATE]: SOSCheckpointType.CREATED,
    [SOSTransitionType.ACKNOWLEDGE]: SOSCheckpointType.ACKNOWLEDGED,
    [SOSTransitionType.START_RESPONSE]: SOSCheckpointType.IN_PROGRESS,
    [SOSTransitionType.RESOLVE]: SOSCheckpointType.RESOLVED,
    [SOSTransitionType.CANCEL]: SOSCheckpointType.CANCELLED,
    [SOSTransitionType.ESCALATE]: SOSCheckpointType.ESCALATED,
  };

  return mapping[transitionType];
}

async function recordSOSCheckpoint(
  tx: Prisma.TransactionClient,
  params: {
    alertId: string;
    checkpointType: SOSCheckpointType;
    timestamp: Date;
    actorUserId?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }
): Promise<void> {
  await tx.sOSCheckpoint.create({
    data: {
      alertId: params.alertId,
      checkpointType: params.checkpointType,
      timestamp: params.timestamp,
      actorUserId: params.actorUserId,
      metadata: params.metadata ? JSON.parse(JSON.stringify(params.metadata)) : {},
    },
  });
}

// ============================================================================
// CORE STATE TRANSITION
// ============================================================================

/**
 * Atomic SOS state transition with audit trail and notifications.
 * All SOS state changes MUST flow through this function.
 */
export async function transitionSOSState(
  tx: Prisma.TransactionClient,
  transition: SOSStateTransition
): Promise<{ alert: SOSAlert; notificationsSent: number }> {
  logger.info(
    {
      alertId: transition.alertId,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      transitionType: transition.transitionType,
    },
    "[sos-coordinator] Transitioning"
  );

  // 1. Validate transition is legal
  validateTransition(transition);

  // 2. Build update data based on transition type
  const updateData: Prisma.SOSAlertUpdateInput = {
    status: transition.toStatus,
    updatedAt: transition.timestamp,
  };

  if (transition.transitionType === SOSTransitionType.ACKNOWLEDGE && transition.actorUserId) {
    const createdAt = await tx.sOSAlert.findUnique({
      where: { id: transition.alertId },
      select: { createdAt: true },
    });

    const responseTimeSec = createdAt
      ? Math.floor((transition.timestamp.getTime() - createdAt.createdAt.getTime()) / 1000)
      : 0;

    updateData.acknowledgedBy = transition.actorUserId;
    updateData.acknowledgedAt = transition.timestamp;
    updateData.responseTime = responseTimeSec;
    updateData.assignedGuard = { connect: { id: transition.actorUserId } };
  } else if (transition.transitionType === SOSTransitionType.START_RESPONSE && transition.actorUserId) {
    updateData.inProgressAt = transition.timestamp;
    updateData.assignedGuard = { connect: { id: transition.actorUserId } };
  } else if (transition.transitionType === SOSTransitionType.RESOLVE && transition.actorUserId) {
    updateData.resolvedBy = transition.actorUserId;
    updateData.resolvedAt = transition.timestamp;
  } else if (transition.transitionType === SOSTransitionType.CANCEL) {
    updateData.resolvedAt = transition.timestamp;
    if (transition.metadata?.cancelReason) {
      updateData.cancelReason = String(transition.metadata.cancelReason);
    }
  } else if (transition.transitionType === SOSTransitionType.ESCALATE) {
    updateData.escalationNotifiedAt = transition.timestamp;
  }

  // 3. Update alert status atomically
  const alert = await tx.sOSAlert.update({
    where: { id: transition.alertId },
    data: updateData,
    include: {
      villa: {
        select: {
          villaNumber: true,
          block: true,
        },
      },
      user: {
        select: {
          name: true,
        },
      },
    },
  });

  // 4. Create audit checkpoint
  await recordSOSCheckpoint(tx, {
    alertId: transition.alertId,
    checkpointType: mapTransitionToCheckpointType(transition.transitionType),
    timestamp: transition.timestamp,
    actorUserId: transition.actorUserId,
    metadata: transition.metadata,
  });

  // 5. Send notifications (centralized routing)
  const notificationCount = await sendSOSNotifications(tx, {
    alert,
    transition,
  });

  logger.info(
    {
      alertId: alert.id,
      newStatus: alert.status,
      notificationsSent: notificationCount,
    },
    "[sos-coordinator] Transition complete"
  );

  return { alert, notificationsSent: notificationCount };
}

// ============================================================================
// NOTIFICATION ROUTING
// ============================================================================

async function sendSOSNotifications(
  tx: Prisma.TransactionClient,
  params: {
    alert: SOSAlert & {
      villa: { villaNumber: string; block: string | null };
      user: { name: string } | null;
    };
    transition: Partial<SOSStateTransition>;
  }
): Promise<number> {
  const { alert, transition } = params;
  let notificationsSent = 0;

  const villaLabel = alert.villa.block
    ? `${alert.villa.block} · ${alert.villa.villaNumber}`
    : alert.villa.villaNumber;

  try {
    switch (transition.transitionType) {
      case SOSTransitionType.CREATE:
        // Notify guards and admins
        await notifySocietyRoles({
          societyId: alert.societyId,
          roles: [UserRole.GUARD, UserRole.ADMIN],
          category: NotificationCategory.SOS,
          title: `🚨 SOS: ${alert.emergencyType}`,
          body: `${alert.user?.name ?? "Unknown resident"} · ${villaLabel}${
            alert.message ? ` · ${alert.message}` : ""
          }`,
          data: {
            alertId: alert.id,
            villaId: alert.villaId,
            emergencyType: alert.emergencyType,
            type: "SOS_CREATED",
          },
        });
        notificationsSent++;
        break;

      case SOSTransitionType.ACKNOWLEDGE:
        // Notify resident
        if (alert.triggeredBy) {
          await notifyUserIds([alert.triggeredBy], {
            title: "Help is on the way",
            body: "A guard has acknowledged your SOS.",
            data: {
              alertId: alert.id,
              type: "SOS_UPDATE",
              sosStatus: SOSStatus.ACKNOWLEDGED,
            },
          });
          notificationsSent++;
        }
        break;

      case SOSTransitionType.START_RESPONSE:
        // Notify resident
        if (alert.triggeredBy) {
          await notifyUserIds([alert.triggeredBy], {
            title: "Response in progress",
            body: "Emergency responders are attending your SOS.",
            data: {
              alertId: alert.id,
              type: "SOS_UPDATE",
              sosStatus: SOSStatus.IN_PROGRESS,
            },
          });
          notificationsSent++;
        }
        break;

      case SOSTransitionType.RESOLVE:
        // Notify resident
        if (alert.triggeredBy) {
          await notifyUserIds([alert.triggeredBy], {
            title: "SOS resolved",
            body: "Your emergency alert has been closed by security.",
            data: {
              alertId: alert.id,
              type: "SOS_UPDATE",
              sosStatus: SOSStatus.RESOLVED,
            },
          });
          notificationsSent++;
        }
        break;

      case SOSTransitionType.CANCEL:
        // Notify guards and admins
        await notifySocietyRoles({
          societyId: alert.societyId,
          roles: [UserRole.GUARD, UserRole.ADMIN],
          category: NotificationCategory.SOS,
          title: "SOS cancelled by resident",
          body: String(transition.metadata?.cancelReason || "No reason provided"),
          data: { alertId: alert.id, type: "SOS_CANCELLED" },
        });
        notificationsSent++;
        break;

      case SOSTransitionType.ESCALATE:
        // Re-notify guards (louder)
        await notifySocietyRoles({
          societyId: alert.societyId,
          roles: [UserRole.GUARD],
          category: NotificationCategory.SOS,
          title: "🚨 SOS — STILL UNACKNOWLEDGED",
          body: `${alert.emergencyType} · ${villaLabel} · No acknowledgment in 30s`,
          data: {
            alertId: alert.id,
            type: "SOS_ESCALATION",
            emergencyType: alert.emergencyType,
          },
        });
        notificationsSent++;

        // Escalate to admins
        await notifySocietyRoles({
          societyId: alert.societyId,
          roles: [UserRole.ADMIN],
          category: NotificationCategory.SOS,
          title: "Admin: SOS escalation",
          body: `${alert.emergencyType} · ${villaLabel} · No acknowledgment in 30s`,
          data: {
            alertId: alert.id,
            type: "SOS_ESCALATION_ADMIN",
            emergencyType: alert.emergencyType,
          },
        });
        notificationsSent++;
        break;
    }
  } catch (err) {
    logger.error({ err, alertId: alert.id }, "[sos-coordinator] Notification failed");
  }

  return notificationsSent;
}

// ============================================================================
// HIGH-LEVEL OPERATIONS
// ============================================================================

/**
 * Create a new SOS alert (resident action).
 */
export async function createSOSAlert(
  tx: Prisma.TransactionClient,
  params: CreateSOSParams
): Promise<SOSAlert> {
  logger.info(
    {
      societyId: params.societyId,
      villaId: params.villaId,
      triggeredBy: params.triggeredBy,
      emergencyType: params.emergencyType,
    },
    "[sos-coordinator] Creating alert"
  );

  // Check for duplicate open SOS
  const duplicate = await tx.sOSAlert.findFirst({
    where: {
      triggeredBy: params.triggeredBy,
      societyId: params.societyId,
      status: { in: OPEN_SOS_STATUSES },
    },
    select: { id: true },
  });

  if (duplicate) {
    throw new Error("DUPLICATE_OPEN_SOS");
  }

  const now = new Date();

  // Create alert
  const alert = await tx.sOSAlert.create({
    data: {
      societyId: params.societyId,
      villaId: params.villaId,
      triggeredBy: params.triggeredBy,
      emergencyType: params.emergencyType,
      message: params.message,
      location: params.location,
      latitude: params.latitude,
      longitude: params.longitude,
      status: SOSStatus.CREATED,
    },
    include: {
      villa: {
        select: {
          villaNumber: true,
          block: true,
        },
      },
      user: {
        select: {
          name: true,
        },
      },
    },
  });

  // Record checkpoint
  await recordSOSCheckpoint(tx, {
    alertId: alert.id,
    checkpointType: SOSCheckpointType.CREATED,
    timestamp: now,
    actorUserId: params.triggeredBy,
    metadata: {
      emergencyType: params.emergencyType,
      location: params.location || null,
    },
  });

  // Send notifications
  await sendSOSNotifications(tx, {
    alert,
    transition: {
      transitionType: SOSTransitionType.CREATE,
      actorUserId: params.triggeredBy,
    },
  });

  // Schedule escalation in DB (not in-memory timer)
  await tx.sOSEscalation.create({
    data: {
      alertId: alert.id,
      scheduledAt: new Date(now.getTime() + 30_000), // 30 seconds from now
      status: "PENDING",
    },
  });

  logger.info({ alertId: alert.id }, "[sos-coordinator] Alert created with escalation scheduled");

  return alert;
}

/**
 * Process pending escalations (called by cron).
 * Should be wrapped in advisory lock to prevent duplicate execution.
 */
export async function processEscalations(tx: Prisma.TransactionClient): Promise<number> {
  const now = new Date();

  // Find pending escalations whose time has come
  const pendingEscalations = await tx.sOSEscalation.findMany({
    where: {
      status: "PENDING",
      scheduledAt: { lte: now },
    },
    include: {
      alert: {
        select: {
          id: true,
          status: true,
          acknowledgedAt: true,
          escalationNotifiedAt: true,
          societyId: true,
        },
      },
    },
    take: 50, // Process in batches
  });

  let escalated = 0;

  for (const escalation of pendingEscalations) {
    const { alert } = escalation;

    // Skip if already acknowledged or resolved
    if (alert.acknowledgedAt) {
      await tx.sOSEscalation.update({
        where: { id: escalation.id },
        data: { status: "SKIPPED", processedAt: now },
      });
      continue;
    }

    if (alert.status === SOSStatus.RESOLVED || alert.status === SOSStatus.CANCELLED) {
      await tx.sOSEscalation.update({
        where: { id: escalation.id },
        data: { status: "SKIPPED", processedAt: now },
      });
      continue;
    }

    // Skip if already escalated
    if (alert.escalationNotifiedAt) {
      await tx.sOSEscalation.update({
        where: { id: escalation.id },
        data: { status: "SKIPPED", processedAt: now },
      });
      continue;
    }

    // Execute escalation
    try {
      await transitionSOSState(tx, {
        alertId: alert.id,
        fromStatus: alert.status,
        toStatus: alert.status, // Same status, just re-notify
        transitionType: SOSTransitionType.ESCALATE,
        societyId: alert.societyId,
        timestamp: now,
      });

      await tx.sOSEscalation.update({
        where: { id: escalation.id },
        data: { status: "EXECUTED", processedAt: now },
      });

      escalated++;
    } catch (err) {
      logger.error({ err, alertId: alert.id }, "[sos-coordinator] Escalation failed");
      await tx.sOSEscalation.update({
        where: { id: escalation.id },
        data: { status: "FAILED", processedAt: now },
      });
    }
  }

  if (escalated > 0) {
    logger.info({ count: escalated }, "[sos-coordinator] Escalations processed");
  }

  return escalated;
}
