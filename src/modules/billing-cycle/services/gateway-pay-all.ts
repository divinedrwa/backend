import type { BillingCycle } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { getVillaCreditBalance } from "../../maintenance-management/credit-walker";
import { computeAmountDueForCycle } from "../domain/amountDue";
import { computeUserBillingLedger } from "./cycle-service";

export type GatewayCheckoutQuote = {
  /** Maintenance due before advance credit (matches hub remainingDue). */
  grossDue: number;
  /** Advance credit available from billing ledger + credit walker. */
  availableCredit: number;
  /** Portion of grossDue covered by advance credit at checkout. */
  creditApplied: number;
  /** Cash amount charged via payment gateway (grossDue − creditApplied). */
  maintenanceAmount: number;
};

export type PayAllQuote = {
  /** Oldest pending billing cycle — anchor for UserCyclePayment + ledger payment row */
  anchorCycleId: string;
  anchorMonth: number;
  anchorYear: number;
  /** Sum of maintenance due across all pending cycles (excludes gateway fee/GST) */
  maintenanceTotal: number;
  pendingCycleIds: string[];
  pendingCount: number;
};

function parseCycleMonthYear(cycleKey: string): { month: number; year: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(cycleKey);
  if (m) {
    return { year: Number(m[1]), month: Number(m[2]) };
  }
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

/**
 * Per-cycle maintenance due — matches hub `remainingDue` and maintenance-pending.
 * Uses ledger snapshot truth (expected incl. late fee − cash paid); no double-counting.
 */
export async function computeCycleAdjustedDue(
  societyId: string,
  userId: string,
  cycle: Pick<BillingCycle, "id" | "amount" | "cycleKey" | "lateFee" | "paymentEndDate" | "gracePeriodDays">,
  ledgerRow?: { expectedAmount: number; cashPaidAmount: number; balanceBefore: number },
): Promise<number> {
  if (ledgerRow) {
    return Math.max(0, ledgerRow.expectedAmount - ledgerRow.cashPaidAmount);
  }

  const waiver = await prisma.billingLateFeeWaiver.findUnique({
    where: { cycleId_userId: { cycleId: cycle.id, userId } },
  });
  const due = computeAmountDueForCycle(
    cycle as BillingCycle,
    new Date(),
    Boolean(waiver),
  );
  return Math.max(0, due.totalDue);
}

/**
 * Advance credit visible to a resident — max(billing ledger balance, walker pool).
 */
export async function resolveAvailableAdvanceCredit(
  societyId: string,
  userId: string,
  options?: { balanceBefore?: number; financialYearId?: string | null },
): Promise<number> {
  const ledgerCredit = Math.max(0, options?.balanceBefore ?? 0);

  const user = await prisma.user.findFirst({
    where: { id: userId, societyId },
    select: { villaId: true },
  });
  if (!user?.villaId) return ledgerCredit;

  let financialYearId = options?.financialYearId ?? null;
  if (!financialYearId) {
    const activeFy = await prisma.financialYear.findFirst({
      where: { societyId, status: "ACTIVE" },
      select: { id: true },
    });
    financialYearId = activeFy?.id ?? null;
  }
  if (!financialYearId) return ledgerCredit;

  const { creditPool } = await getVillaCreditBalance(prisma, {
    societyId,
    villaId: user.villaId,
    financialYearId,
  });
  return Math.max(ledgerCredit, creditPool);
}

function buildGatewayCheckoutQuote(grossDue: number, availableCredit: number): GatewayCheckoutQuote {
  const creditApplied = Math.min(Math.max(0, availableCredit), Math.max(0, grossDue));
  const maintenanceAmount = Math.max(0, grossDue - creditApplied);
  return { grossDue, availableCredit, creditApplied, maintenanceAmount };
}

/** Single-cycle gateway checkout — subtracts advance credit from the cash charge. */
export async function computeGatewayCheckoutQuoteForCycle(
  societyId: string,
  userId: string,
  cycle: Pick<BillingCycle, "id" | "amount" | "cycleKey" | "lateFee" | "paymentEndDate" | "gracePeriodDays" | "financialYearId">,
  ledgerRow?: { expectedAmount: number; cashPaidAmount: number; balanceBefore: number },
): Promise<GatewayCheckoutQuote> {
  const grossDue = await computeCycleAdjustedDue(societyId, userId, cycle, ledgerRow);
  const availableCredit = await resolveAvailableAdvanceCredit(societyId, userId, {
    balanceBefore: ledgerRow?.balanceBefore,
    financialYearId: cycle.financialYearId,
  });
  return buildGatewayCheckoutQuote(grossDue, availableCredit);
}

export type PayAllCheckoutQuote = PayAllQuote & GatewayCheckoutQuote;

/**
 * Quote for "Pay all" — every billing cycle with remaining maintenance due.
 */
export async function computePayAllQuote(
  societyId: string,
  userId: string,
): Promise<PayAllQuote | null> {
  const ledger = await computeUserBillingLedger(societyId, userId);
  const pendingRows = ledger.cycles
    .filter((row) => Math.max(0, row.expectedAmount - row.paidAmount) > 0.005)
    .sort((a, b) => a.cycleKey.localeCompare(b.cycleKey));

  if (pendingRows.length === 0) return null;

  const cycles = await prisma.billingCycle.findMany({
    where: { societyId, id: { in: pendingRows.map((r) => r.cycleId) } },
    select: {
      id: true,
      amount: true,
      cycleKey: true,
      lateFee: true,
      paymentEndDate: true,
      gracePeriodDays: true,
    },
  });
  const cycleById = new Map(cycles.map((c) => [c.id, c]));

  let maintenanceTotal = 0;
  const pendingCycleIds: string[] = [];

  for (const row of pendingRows) {
    const cycle = cycleById.get(row.cycleId);
    if (!cycle) continue;
    const adjusted = await computeCycleAdjustedDue(societyId, userId, cycle, row);
    if (adjusted <= 0.005) continue;
    maintenanceTotal += adjusted;
    pendingCycleIds.push(cycle.id);
  }

  if (pendingCycleIds.length === 0 || maintenanceTotal <= 0.005) return null;

  const anchor = cycleById.get(pendingCycleIds[0]!)!;
  const { month, year } = parseCycleMonthYear(anchor.cycleKey);

  return {
    anchorCycleId: anchor.id,
    anchorMonth: month,
    anchorYear: year,
    maintenanceTotal,
    pendingCycleIds,
    pendingCount: pendingCycleIds.length,
  };
}

/** Pay-all gateway checkout — applies advance credit once against the combined due. */
export async function computeGatewayPayAllCheckoutQuote(
  societyId: string,
  userId: string,
): Promise<PayAllCheckoutQuote | null> {
  const payAll = await computePayAllQuote(societyId, userId);
  if (!payAll) return null;

  const ledger = await computeUserBillingLedger(societyId, userId);
  const anchorCycle = await prisma.billingCycle.findUnique({
    where: { id: payAll.anchorCycleId },
    select: { financialYearId: true },
  });
  const availableCredit = await resolveAvailableAdvanceCredit(societyId, userId, {
    balanceBefore: ledger.currentBalance,
    financialYearId: anchorCycle?.financialYearId,
  });
  const checkout = buildGatewayCheckoutQuote(payAll.maintenanceTotal, availableCredit);

  return { ...payAll, ...checkout };
}
