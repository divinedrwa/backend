import { NotificationCategory, UserRole } from "@prisma/client";
import { prisma } from "./prisma";
import { notifySocietyRoles, notifyUsers } from "../services/notification.service";

export type MaintenanceLedgerNotifyType =
  | "MAINTENANCE_PAYMENT_RECORDED"
  | "MAINTENANCE_PAYMENT_REVERSED"
  | "MAINTENANCE_LEDGER_UPDATED";

/** Push + in-app inbox so resident/guard apps refresh maintenance data. */
export async function notifyVillaMaintenanceLedgerUpdate(params: {
  societyId: string;
  villaId: string;
  type: MaintenanceLedgerNotifyType;
  title: string;
  body: string;
}): Promise<void> {
  try {
    const residents = await prisma.user.findMany({
      where: {
        societyId: params.societyId,
        villaId: params.villaId,
        role: UserRole.RESIDENT,
        isActive: true,
      },
      select: { id: true },
    });
    if (residents.length === 0) return;

    await notifyUsers(
      residents.map((r) => r.id),
      {
        title: params.title,
        body: params.body,
        data: { type: params.type, villaId: params.villaId },
      },
      { category: NotificationCategory.MAINTENANCE },
    );
  } catch {
    // Fire-and-forget
  }
}

/** Notify all residents in a society (e.g. after bulk snapshot regenerate). */
export async function notifySocietyMaintenanceLedgerUpdate(params: {
  societyId: string;
  type: MaintenanceLedgerNotifyType;
  title: string;
  body: string;
}): Promise<void> {
  try {
    await notifySocietyRoles({
      societyId: params.societyId,
      roles: [UserRole.RESIDENT],
      title: params.title,
      body: params.body,
      data: { type: params.type },
      category: NotificationCategory.MAINTENANCE,
    });
  } catch {
    // Fire-and-forget
  }
}
