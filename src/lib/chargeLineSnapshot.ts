import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export type ChargeLineDto = {
  chargeHeadId?: string;
  code?: string;
  label: string;
  amount: number;
  sortOrder: number;
};

type BillingCycleRef = {
  id: string;
  financialYearId: string | null;
  cycleKey: string;
};

/** Parse charge lines stored on snapshot.breakdown when DB rows are absent. */
export function parseChargeLinesFromBreakdown(breakdown: unknown): ChargeLineDto[] {
  if (!breakdown || typeof breakdown !== "object") return [];
  const raw = (breakdown as { chargeLines?: unknown }).chargeLines;
  if (!Array.isArray(raw)) return [];

  const lines: ChargeLineDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const amount = Number(row.amount);
    if (!label || !Number.isFinite(amount)) continue;
    lines.push({
      chargeHeadId: typeof row.chargeHeadId === "string" ? row.chargeHeadId : undefined,
      code: typeof row.code === "string" ? row.code : undefined,
      label,
      amount: Math.round(amount * 100) / 100,
      sortOrder: Number(row.sortOrder) || lines.length,
    });
  }
  return lines.sort((a, b) => a.sortOrder - b.sortOrder);
}

function linesFromSnapshot(
  chargeLines: Array<{
    chargeHeadId: string;
    label: string;
    amount: Prisma.Decimal;
    sortOrder: number;
    chargeHead: { code: string };
  }>,
  breakdown: unknown,
): ChargeLineDto[] {
  if (chargeLines.length > 0) {
    return chargeLines
      .map((l) => ({
        chargeHeadId: l.chargeHeadId,
        code: l.chargeHead.code,
        label: l.label,
        amount: Number(l.amount),
        sortOrder: l.sortOrder,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return parseChargeLinesFromBreakdown(breakdown);
}

/**
 * Batch-load charge lines keyed by billing cycle id for one villa.
 * Returns empty map entries when no multi-head bill exists (legacy single-line).
 */
export async function loadChargeLinesByBillingCycleIds(
  params: { villaId: string; cycles: BillingCycleRef[] },
): Promise<Map<string, ChargeLineDto[]>> {
  const result = new Map<string, ChargeLineDto[]>();
  const cycles = params.cycles.filter((c) => c.financialYearId);
  if (cycles.length === 0) return result;

  const maintenanceCycles = await prisma.maintenanceCollectionCycle.findMany({
    where: {
      OR: cycles.map((c) => ({
        financialYearId: c.financialYearId!,
        periodKey: c.cycleKey,
      })),
    },
    select: { id: true, financialYearId: true, periodKey: true },
  });

  const billingIdByMcId = new Map<string, string>();
  for (const mc of maintenanceCycles) {
    const bc = cycles.find(
      (c) => c.financialYearId === mc.financialYearId && c.cycleKey === mc.periodKey,
    );
    if (bc) billingIdByMcId.set(mc.id, bc.id);
  }

  const mcIds = maintenanceCycles.map((m) => m.id);
  if (mcIds.length === 0) return result;

  const snaps = await prisma.villaMaintenanceSnapshot.findMany({
    where: { villaId: params.villaId, cycleId: { in: mcIds } },
    select: {
      cycleId: true,
      breakdown: true,
      chargeLines: {
        orderBy: { sortOrder: "asc" },
        select: {
          chargeHeadId: true,
          label: true,
          amount: true,
          sortOrder: true,
          chargeHead: { select: { code: true } },
        },
      },
    },
  });

  for (const snap of snaps) {
    const billingCycleId = billingIdByMcId.get(snap.cycleId);
    if (!billingCycleId) continue;
    const lines = linesFromSnapshot(snap.chargeLines, snap.breakdown);
    if (lines.length > 0) result.set(billingCycleId, lines);
  }

  return result;
}

/** Load charge lines for one billing cycle + villa (receipt PDF). */
export async function loadChargeLinesForBillingCycle(
  villaId: string,
  cycle: BillingCycleRef,
): Promise<ChargeLineDto[]> {
  const map = await loadChargeLinesByBillingCycleIds({
    villaId,
    cycles: [cycle],
  });
  return map.get(cycle.id) ?? [];
}
