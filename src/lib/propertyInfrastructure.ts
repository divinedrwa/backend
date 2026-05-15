import type { Prisma } from "@prisma/client";
import { BillingAccountScope } from "@prisma/client";
import { prisma } from "./prisma";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Stable segment from `villaNumber` for auto-generated unit codes (e.g. V-12 → V12).
 * Used for suggested codes `V{prefix}_GF` / `V{prefix}_FF`.
 */
export function unitCodePrefixFromVillaNumber(villaNumber: string): string {
  const slug = villaNumber.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const base = slug.length > 0 ? slug : "VILLA";
  return base.slice(0, 48);
}

/** Suggested occupant unit codes (admin UI + auto-provisioned shell/import villas). */
export const SUGGESTED_UNIT_SUFFIX_GF = "_GF";
export const SUGGESTED_UNIT_SUFFIX_FF = "_FF";

/**
 * Creates Ground floor + First floor suggested units if missing (idempotent).
 * GF is marked default for billing / visitor fallback when no explicit unit is chosen.
 */
export async function createSuggestedOccupantUnitsIfMissing(
  db: Db,
  params: { societyId: string; villaId: string; villaNumber: string },
): Promise<void> {
  const prefix = unitCodePrefixFromVillaNumber(params.villaNumber);
  const pairs: Array<{
    unitCode: string;
    label: string;
    sortOrder: number;
    isDefault: boolean;
  }> = [
    {
      unitCode: `V${prefix}${SUGGESTED_UNIT_SUFFIX_GF}`,
      label: "Ground floor",
      sortOrder: 0,
      isDefault: true,
    },
    {
      unitCode: `V${prefix}${SUGGESTED_UNIT_SUFFIX_FF}`,
      label: "First floor",
      sortOrder: 1,
      isDefault: false,
    },
  ];

  for (const p of pairs) {
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
