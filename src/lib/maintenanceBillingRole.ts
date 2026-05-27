import {
  MaintenanceBillingRole,
  Prisma,
} from "@prisma/client";
import { prisma } from "./prisma";
import { RESIDENT_LIKE_ROLES } from "./residentLike";

export async function defaultMaintenanceBillingRoleForNewResident(params: {
  societyId: string;
  villaId: string;
}): Promise<MaintenanceBillingRole> {
  const primaryCount = await prisma.user.count({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      role: { in: [...RESIDENT_LIKE_ROLES] },
      isActive: true,
      maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
    },
  });
  return primaryCount > 0
    ? MaintenanceBillingRole.EXCLUDED
    : MaintenanceBillingRole.PRIMARY;
}

export async function demoteOtherResidentsToExcluded(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    villaId: string;
    primaryUserId: string;
  }
): Promise<void> {
  await tx.user.updateMany({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      role: { in: [...RESIDENT_LIKE_ROLES] },
      id: { not: params.primaryUserId },
    },
    data: { maintenanceBillingRole: MaintenanceBillingRole.EXCLUDED },
  });
}

/** True if another active resident on the same villa is already PRIMARY (excluding `exceptUserId`). */
export async function hasOtherPrimaryOnVilla(params: {
  societyId: string;
  villaId: string;
  exceptUserId: string;
}): Promise<boolean> {
  const n = await prisma.user.count({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      role: { in: [...RESIDENT_LIKE_ROLES] },
      isActive: true,
      maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
      NOT: { id: params.exceptUserId },
    },
  });
  return n > 0;
}

export async function clearExcludedResidentsUserCyclePayments(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    villaId: string;
    billingCycleId: string;
  }
): Promise<void> {
  const excluded = await tx.user.findMany({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      role: { in: [...RESIDENT_LIKE_ROLES] },
      maintenanceBillingRole: MaintenanceBillingRole.EXCLUDED,
    },
    select: { id: true },
  });
  if (excluded.length === 0) return;
  await tx.userCyclePayment.deleteMany({
    where: {
      cycleId: params.billingCycleId,
      userId: { in: excluded.map((u) => u.id) },
    },
  });
}

/**
 * Ensures at most one PRIMARY among active residents on a villa; if none, promotes the earliest resident.
 */
export async function ensurePrimaryCoverageForVilla(
  tx: Prisma.TransactionClient,
  params: { societyId: string; villaId: string }
): Promise<void> {
  const active = await tx.user.findMany({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      role: { in: [...RESIDENT_LIKE_ROLES] },
      isActive: true,
    },
    select: {
      id: true,
      maintenanceBillingRole: true,
      moveInDate: true,
      createdAt: true,
    },
    orderBy: [{ moveInDate: "asc" }, { createdAt: "asc" }],
  });
  if (active.length === 0) return;

  const primaryIds = active
    .filter((u) => u.maintenanceBillingRole === MaintenanceBillingRole.PRIMARY)
    .map((u) => u.id);

  if (primaryIds.length === 1) {
    await tx.user.updateMany({
      where: {
        societyId: params.societyId,
        villaId: params.villaId,
        role: { in: [...RESIDENT_LIKE_ROLES] },
        isActive: true,
        id: { not: primaryIds[0] },
        maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
      },
      data: { maintenanceBillingRole: MaintenanceBillingRole.EXCLUDED },
    });
    return;
  }

  if (primaryIds.length > 1) {
    const keep = primaryIds[0];
    await tx.user.updateMany({
      where: { id: { in: primaryIds.filter((pid) => pid !== keep) } },
      data: { maintenanceBillingRole: MaintenanceBillingRole.EXCLUDED },
    });
    return;
  }

  const promote = active[0];
  await tx.user.update({
    where: { id: promote.id },
    data: { maintenanceBillingRole: MaintenanceBillingRole.PRIMARY },
  });
  await tx.user.updateMany({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      role: { in: [...RESIDENT_LIKE_ROLES] },
      isActive: true,
      id: { not: promote.id },
    },
    data: { maintenanceBillingRole: MaintenanceBillingRole.EXCLUDED },
  });
}
