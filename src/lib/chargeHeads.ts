import type { ChargeHeadAmountType, Prisma } from "@prisma/client";

export type ChargeHeadRow = {
  id: string;
  code: string;
  label: string;
  amountType: ChargeHeadAmountType;
  fixedAmount: Prisma.Decimal | null;
  perSqftRate: Prisma.Decimal | null;
  sortOrder: number;
  isActive: boolean;
};

export type ChargeLineResult = {
  chargeHeadId: string;
  code: string;
  label: string;
  amount: number;
  sortOrder: number;
};

export type ChargeHeadBreakdown = {
  chargeLines: ChargeLineResult[];
  totalAmount: number;
};

function toNum(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === "number" ? v : Number(v);
}

/** Compute one charge head line for a villa (sqft defaults to 0 when missing). */
export function computeChargeHeadLineAmount(
  head: Pick<ChargeHeadRow, "amountType" | "fixedAmount" | "perSqftRate">,
  sqft: number,
): number {
  if (head.amountType === "PER_SQFT") {
    const rate = toNum(head.perSqftRate);
    if (rate <= 0) return 0;
    return Math.round(rate * Math.max(0, sqft) * 100) / 100;
  }
  return Math.round(toNum(head.fixedAmount) * 100) / 100;
}

/** Sum active charge heads when society opted in; otherwise null (caller uses legacy path). */
export function computeChargeHeadBreakdown(
  heads: ChargeHeadRow[],
  sqft: number,
  useChargeHeads: boolean,
): ChargeHeadBreakdown | null {
  if (!useChargeHeads) return null;
  const active = heads.filter((h) => h.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
  if (active.length === 0) return null;

  const chargeLines: ChargeLineResult[] = active.map((h) => ({
    chargeHeadId: h.id,
    code: h.code,
    label: h.label,
    amount: computeChargeHeadLineAmount(h, sqft),
    sortOrder: h.sortOrder,
  }));

  const totalAmount =
    Math.round(chargeLines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;

  return { chargeLines, totalAmount };
}

export function chargeHeadBreakdownToJson(
  breakdown: ChargeHeadBreakdown,
): Record<string, unknown> {
  return {
    chargeLines: breakdown.chargeLines.map((l) => ({
      chargeHeadId: l.chargeHeadId,
      code: l.code,
      label: l.label,
      amount: l.amount,
      sortOrder: l.sortOrder,
    })),
    totalAmount: breakdown.totalAmount,
  };
}
