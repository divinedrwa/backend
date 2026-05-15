import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getOrCreateDefaultUnitIdForVilla } from "./propertyInfrastructure";

type Db = Prisma.TransactionClient | typeof prisma;

export type ResolvedResidentDwelling = {
  villaId: string;
  unitId: string;
};

/**
 * Resolves villa + unit for a resident. Prefers `unitId` when set (and checks consistency with `villaId`).
 * If only `villaId` is provided, uses the property preferred unit (`isDefault`, else legacy `_DEFAULT`, else first by sort).
 */
export async function resolveResidentDwelling(
  db: Db,
  params: {
    societyId: string;
    villaId?: string | null;
    unitId?: string | null;
  }
): Promise<ResolvedResidentDwelling | null> {
  if (params.unitId?.trim()) {
    const unit = await db.unit.findFirst({
      where: { id: params.unitId.trim(), societyId: params.societyId },
      select: { id: true, villaId: true },
    });
    if (!unit) return null;
    if (params.villaId && params.villaId !== unit.villaId) return null;
    return { villaId: unit.villaId, unitId: unit.id };
  }

  if (params.villaId?.trim()) {
    const villaId = params.villaId.trim();
    const villa = await db.villa.findFirst({
      where: { id: villaId, societyId: params.societyId },
      select: { id: true },
    });
    if (!villa) return null;
    const unitId = await getOrCreateDefaultUnitIdForVilla({
      societyId: params.societyId,
      villaId,
    });
    if (!unitId) return null;
    return { villaId, unitId };
  }

  return null;
}
