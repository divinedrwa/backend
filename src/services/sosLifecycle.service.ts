import { SOSStatus, NotificationCategory, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { notifySocietyRoles, notifyUserIds } from "./notification.service";

/** Societies consider these “open” (not terminal). */
export const OPEN_SOS_STATUSES: SOSStatus[] = [
  SOSStatus.CREATED,
  SOSStatus.ACTIVE,
  SOSStatus.PENDING,
  SOSStatus.ACKNOWLEDGED,
  SOSStatus.IN_PROGRESS,
];

const escalationTimers = new Map<string, NodeJS.Timeout>();

export function scheduleSosEscalation(
  alertId: string,
  societyId: string,
  villaLabel: string,
  emergencyType: string,
) {
  if (escalationTimers.has(alertId)) return;
  const t = setTimeout(() => {
    void runEscalation(alertId, societyId, villaLabel, emergencyType);
  }, 30_000);
  escalationTimers.set(alertId, t);
}

export function clearSosEscalation(alertId: string) {
  const existing = escalationTimers.get(alertId);
  if (existing) {
    clearTimeout(existing);
    escalationTimers.delete(alertId);
  }
}

async function runEscalation(
  alertId: string,
  societyId: string,
  villaLabel: string,
  emergencyType: string,
) {
  escalationTimers.delete(alertId);
  const a = await prisma.sOSAlert.findUnique({ where: { id: alertId } });
  if (!a) return;
  if (a.acknowledgedAt) return;
  if (a.status === SOSStatus.RESOLVED || a.status === SOSStatus.CANCELLED) return;
  if (a.escalationNotifiedAt) return;

  await prisma.sOSAlert.update({
    where: { id: alertId },
    data: { escalationNotifiedAt: new Date() },
  });

  const title = "🚨 SOS — STILL UNACKNOWLEDGED";
  const body = `${emergencyType} · ${villaLabel} · No acknowledgment in 30s`;

  await notifySocietyRoles({
    societyId,
    roles: [UserRole.GUARD],
    category: NotificationCategory.SOS,
    title,
    body,
    data: {
      alertId,
      type: "SOS_ESCALATION",
      emergencyType,
    },
  }).catch(() => undefined);

  await notifySocietyRoles({
    societyId,
    roles: [UserRole.ADMIN],
    category: NotificationCategory.SOS,
    title: "Admin: SOS escalation",
    body,
    data: {
      alertId,
      type: "SOS_ESCALATION_ADMIN",
      emergencyType,
    },
  }).catch(() => undefined);
}

export async function notifyResidentSosUpdate(params: {
  alertId: string;
  residentUserId: string;
  title: string;
  body: string;
  extraData?: Record<string, string>;
}) {
  await notifyUserIds([params.residentUserId], {
    title: params.title,
    body: params.body,
    data: {
      alertId: params.alertId,
      type: "SOS_UPDATE",
      ...params.extraData,
    },
  });
}
