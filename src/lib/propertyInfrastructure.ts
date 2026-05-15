import type { Prisma } from "@prisma/client";
import { BillingAccountScope } from "@prisma/client";
import { prisma } from "./prisma";

import { suggestedOccupantUnitDefinitions } from "./occupantUnitCodes";

export type { SuggestedOccupantUnitDef } from "./occupantUnitCodes";
export {
  occupantUnitCodeStem,
  occupantUnitCodeForFloorIndex,
  occupantUnitLabelForFloorIndex,
  suggestedOccupantUnitDefinitions,
  suggestedUnitSuffixForFloorIndex,
  SUGGESTED_UNIT_SUFFIX_GF,
  SUGGESTED_UNIT_SUFFIX_FF,
  SUGGESTED_UNIT_SUFFIX_SF,
  inferCanonicalTierIndex,
  nextFreeOccupantSlotIndex,
  legacyOccupantUnitCodeForFloorIndex,
} from "./occupantUnitCodes";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Creates suggested occupant units for this property up to `floors` (idempotent by unitCode).
 */
export async function createSuggestedOccupantUnitsIfMissing(
  db: Db,
  params: { societyId: string; villaId: string; villaNumber: string; floors: number },
): Promise<void> {
  const defs = suggestedOccupantUnitDefinitions(params.villaNumber, params.floors);

  for (const p of defs) {
    const exists = await db.unit.findFirst({
      where: { villaId: params.villaId, unitCode: p.unitCode },
      select: { id: true },
    });
    if (exists) continue;
    await db.unit.create({
      data: {
        societyId: params.societyId,
        villaId: params.villaId,
        unitCode: p.unitCode,
        label: p.label,
        sortOrder: p.sortOrder,
        isDefault: p.isDefault,
      },
    });
  }

  await normalizeDefaultUnitFlag(db, params.villaId);
}

/**
 * Picks the unit at `floorIndex` (0 = ground) among this villa’s units by sortOrder.
 * Clamps to an existing row when the index is out of range.
 */
export async function getUnitIdForVillaFloorIndex(
  db: Db,
  params: { societyId: string; villaId: string; floorIndex: number },
): Promise<string | null> {
  const units = await db.unit.findMany({
    where: { villaId: params.villaId, societyId: params.societyId },
    orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }],
    select: { id: true },
  });
  if (units.length === 0) return null;
  const idx = Math.max(0, Math.min(Math.floor(params.floorIndex), units.length - 1));
  return units[idx]!.id;
}

export type VillaUnitPatchRow = {
  unitCode: string;
  label: string;
  sortOrder?: number;
};

/**
 * Upserts all rows in `units`, then removes any other units on this villa — reassigning
 * `User.unitId` and `VisitorVilla.unitId` to the first kept unit (by sortOrder).
 */
export async function syncVillaOccupantUnits(
  db: Db,
  params: { societyId: string; villaId: string; units: VillaUnitPatchRow[] },
): Promise<void> {
  const incoming = params.units
    .map((u) => ({
      unitCode: u.unitCode.trim(),
      label: u.label.trim(),
      sortOrder: u.sortOrder,
    }))
    .filter((u) => u.unitCode.length > 0 && u.label.length > 0 && u.unitCode !== "_DEFAULT");

  if (incoming.length === 0) {
    throw new Error("At least one occupant unit is required");
  }

  const targetCodes = [...new Set(incoming.map((u) => u.unitCode))];

  for (let i = 0; i < incoming.length; i++) {
    const u = incoming[i]!;
    await db.unit.upsert({
      where: { villaId_unitCode: { villaId: params.villaId, unitCode: u.unitCode } },
      create: {
        societyId: params.societyId,
        villaId: params.villaId,
        unitCode: u.unitCode,
        label: u.label,
        sortOrder: u.sortOrder ?? i * 10,
        isDefault: i === 0,
      },
      update: {
        label: u.label,
        sortOrder: u.sortOrder ?? undefined,
      },
    });
  }

  const kept = await db.unit.findMany({
    where: { villaId: params.villaId, societyId: params.societyId, unitCode: { in: targetCodes } },
    orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }],
    select: { id: true },
  });
  const fallbackId = kept[0]?.id;
  if (!fallbackId) {
    throw new Error("Could not resolve a fallback unit after sync");
  }

  const orphans = await db.unit.findMany({
    where: {
      villaId: params.villaId,
      societyId: params.societyId,
      unitCode: { notIn: targetCodes },
    },
    select: { id: true },
  });

  for (const o of orphans) {
    await db.user.updateMany({
      where: { societyId: params.societyId, unitId: o.id },
      data: { unitId: fallbackId },
    });
    await db.visitorVilla.updateMany({
      where: { villaId: params.villaId, unitId: o.id },
      data: { unitId: fallbackId },
    });
    await db.unit.delete({ where: { id: o.id } });
  }

  await normalizeDefaultUnitFlag(db, params.villaId);
}

/**
 * Ensures exactly one `isDefault` unit per property when multiple flags drift
 * (e.g. partial imports). Prefers the lowest sortOrder as the keeper.
 */
export async function normalizeDefaultUnitFlag(db: Db, villaId: string): Promise<void> {
  const units = await db.unit.findMany({
    where: { villaId },
    orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }],
    select: { id: true, isDefault: true },
  });
  if (units.length === 0) return;

  const defaults = units.filter((u) => u.isDefault);
  if (defaults.length === 1) return;

  const keeperId = defaults.length > 0 ? defaults[0]!.id : units[0]!.id;

  for (const u of units) {
    const shouldDefault = u.id === keeperId;
    if (u.isDefault !== shouldDefault) {
      await db.unit.update({
        where: { id: u.id },
        data: { isDefault: shouldDefault },
      });
    }
  }
}

/**
 * One billing account per property (villa). Safe to call on every create/patch.
 */
export async function ensureBillingAccountForProperty(
  db: Db,
  params: { societyId: string; villaId: string },
): Promise<void> {
  await db.billingAccount.upsert({
    where: { villaId: params.villaId },
    create: {
      societyId: params.societyId,
      villaId: params.villaId,
      scope: BillingAccountScope.PROPERTY,
    },
    update: {},
  });
}

/**
 * Picks the unit used when APIs omit an explicit unit:
 * 1) `isDefault: true` (lowest sortOrder)
 * 2) legacy `_DEFAULT` row
 * 3) any first unit by sortOrder
 *
 * Does **not** auto-create rows — properties must have at least one unit.
 */
export async function getPreferredUnitIdForVilla(
  db: Db,
  params: { societyId: string; villaId: string },
): Promise<string | null> {
  const marked = await db.unit.findFirst({
    where: {
      villaId: params.villaId,
      societyId: params.societyId,
      isDefault: true,
    },
    orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }],
    select: { id: true },
  });
  if (marked) return marked.id;

  const legacy = await db.unit.findFirst({
    where: { villaId: params.villaId, unitCode: "_DEFAULT" },
    select: { id: true },
  });
  if (legacy) return legacy.id;

  const any = await db.unit.findFirst({
    where: { villaId: params.villaId, societyId: params.societyId },
    orderBy: [{ sortOrder: "asc" }, { unitCode: "asc" }],
    select: { id: true },
  });
  return any?.id ?? null;
}

/**
 * @deprecated Prefer `ensureBillingAccountForProperty` + explicit unit creation.
 * Keeps billing only; no longer inserts `_DEFAULT` units.
 */
export async function ensureDefaultUnitAndBillingAccount(
  db: Db,
  params: { societyId: string; villaId: string },
): Promise<{ defaultUnitId: string | null }> {
  await ensureBillingAccountForProperty(db, params);
  const defaultUnitId = await getPreferredUnitIdForVilla(db, params);
  return { defaultUnitId };
}

/**
 * Ensures billing exists and returns the preferred unit id for visitor/resident fallbacks.
 * Returns `null` when the property has no units (admin must add at least one).
 */
export async function getOrCreateDefaultUnitIdForVilla(params: {
  societyId: string;
  villaId: string;
  tx?: Prisma.TransactionClient;
}): Promise<string | null> {
  const db = params.tx ?? prisma;
  await ensureBillingAccountForProperty(db, {
    societyId: params.societyId,
    villaId: params.villaId,
  });
  return getPreferredUnitIdForVilla(db, {
    societyId: params.societyId,
    villaId: params.villaId,
  });
}
