import type { Prisma } from "@prisma/client";
import { BillingAccountScope } from "@prisma/client";
import { prisma } from "./prisma";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Ensures a property (`Villa`) has a default occupant unit and a property-scoped billing account.
 * Idempotent — safe to call after villa create and for legacy repair.
 */
export async function ensureDefaultUnitAndBillingAccount(
  db: Db,
  params: { societyId: string; villaId: string }
): Promise<{ defaultUnitId: string }> {
  const existingDefault = await db.unit.findFirst({
    where: { villaId: params.villaId, isDefault: true },
    select: { id: true },
  });
  let defaultUnitId = existingDefault?.id;

  if (!defaultUnitId) {
    const u = await db.unit.create({
      data: {
        societyId: params.societyId,
        villaId: params.villaId,
        unitCode: "_DEFAULT",
        label: "Default",
        sortOrder: 0,
        isDefault: true,
      },
      select: { id: true },
    });
    defaultUnitId = u.id;
  }

  await db.billingAccount.upsert({
    where: { villaId: params.villaId },
    create: {
      societyId: params.societyId,
      villaId: params.villaId,
      scope: BillingAccountScope.PROPERTY,
    },
    update: {},
  });

  return { defaultUnitId };
}

/** Resolve the default unit id for a villa, creating infrastructure if missing (shell villas, imports). */
export async function getOrCreateDefaultUnitIdForVilla(params: {
  societyId: string;
  villaId: string;
}): Promise<string> {
  const { defaultUnitId } = await ensureDefaultUnitAndBillingAccount(prisma, params);
  return defaultUnitId;
}
