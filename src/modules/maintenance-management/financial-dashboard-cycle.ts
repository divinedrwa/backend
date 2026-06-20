import { BillingUserPaymentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { getVillaCreditBalancesBulk } from "./credit-walker";

export type CycleFinancialDashboardCore =
  | {
      cycle: {
        id: string;
        title: string;
        periodMonth: number;
        periodYear: number;
        dueDate: Date;
        status: string;
      };
      month: number;
      year: number;
      residents: Array<{
        villaId: string;
        villaNumber: string;
        ownerName: string;
        amount: number;
        paidTowardCycle?: number;
        status: "PENDING" | "PAID" | "OVERDUE" | "PARTIAL";
        dueDate: Date | null;
        paidAt: Date | null;
        receiptNumber: string | null;
        paymentMode: string | null;
        transactionId: string | null;
        advanceCredit?: number;
        cashPaidThisCycle?: number;
        isExcluded?: boolean;
      }>;
      paymentHistory: Array<{
        id: string;
        villaNumber: string | null;
        ownerName: string | null;
        month: number;
        year: number;
        amount: number;
        paymentDate: Date;
        paymentMode: string;
        receiptNumber: string;
        maintenanceCollectionCycleId: string | null;
      }>;
      summary: {
        totalVillas: number;
        paidCount: number;
        unpaidCount: number;
        overdueCount: number;
        partialCount: number;
        excludedCount: number;
        totalExpected: number;
        collected: number;
        pendingAmount: number;
        collectionRate: number;
      };
    }
  | { error: string };

export function pickMaintenanceCollectionCycleId(query: unknown): string | null {
  const q = query as Record<string, unknown>;
  const raw = q.cycleId ?? q.maintenanceCollectionCycleId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((x): x is string => typeof x === "string" && x.trim().length > 0);
    return first ? first.trim() : null;
  }
  return null;
}

export async function buildCycleFinancialDashboardCore(
  societyId: string,
  cycleId: string
): Promise<CycleFinancialDashboardCore> {
  const cycle = await prisma.maintenanceCollectionCycle.findFirst({
    where: { id: cycleId, societyId },
  });
  if (!cycle) {
    return { error: "Billing period not found" };
  }

  const [villas, snapshots, payments, dashExclusions] = await Promise.all([
    prisma.villa.findMany({
      where: { societyId },
      select: { id: true, villaNumber: true, ownerName: true },
      orderBy: { villaNumber: "asc" },
    }),
    prisma.villaMaintenanceSnapshot.findMany({
      where: { cycleId },
    }),
    prisma.maintenancePayment.findMany({
      where: { societyId, maintenanceCollectionCycleId: cycleId },
      include: { villa: { select: { villaNumber: true, ownerName: true } } },
      orderBy: { paymentDate: "desc" },
    }),
    prisma.cycleVillaExclusion.findMany({
      where: { cycleId },
      select: { villaId: true },
    }),
  ]);

  const dashExcludedIds = new Set(dashExclusions.map((e) => e.villaId));

  if (snapshots.length === 0) {
    return {
      error:
        "No billing snapshots for this period. Configure a rule and generate snapshots first.",
    };
  }

  const snapByVilla = new Map(snapshots.map((s) => [s.villaId, s]));
  const lastPayByVilla = new Map<string, (typeof payments)[0]>();
  for (const p of payments) {
    if (!lastPayByVilla.has(p.villaId)) lastPayByVilla.set(p.villaId, p);
  }

  // Gateway (online) payments settle the snapshot without creating a cash
  // MaintenancePayment, so they'd otherwise show no payment mode. Find the
  // villas paid online for this period (via the matching BillingCycle) so we
  // can label them "ONLINE" — only real gateway successes, never credit/waived.
  const gatewayVillaIds = new Set<string>();
  const gatewayByVilla = new Map<
    string,
    { transactionId: string | null; receiptNumber: string | null }
  >();
  const billingCycle = await prisma.billingCycle.findFirst({
    where: { societyId, cycleKey: cycle.periodKey },
    select: { id: true },
  });
  if (billingCycle) {
    const gatewayPayments = await prisma.userCyclePayment.findMany({
      where: {
        cycleId: billingCycle.id,
        paymentStatus: BillingUserPaymentStatus.SUCCESS,
      },
      select: {
        paymentGatewayPaymentId: true,
        paymentGatewayOrderId: true,
        invoiceNumber: true,
        user: { select: { villaId: true } },
      },
    });
    for (const gp of gatewayPayments) {
      const villaId = gp.user?.villaId;
      if (!villaId) continue;
      gatewayVillaIds.add(villaId);
      gatewayByVilla.set(villaId, {
        transactionId: gp.paymentGatewayPaymentId ?? gp.paymentGatewayOrderId ?? null,
        receiptNumber: gp.invoiceNumber ?? null,
      });
    }
  }

  // Compute per-villa advance credit balances
  const creditBalances = await getVillaCreditBalancesBulk(prisma, {
    societyId,
    financialYearId: cycle.financialYearId,
  });

  // Sum actual cash payments per villa for this cycle
  const cashByVilla = new Map<string, number>();
  for (const p of payments) {
    cashByVilla.set(p.villaId, (cashByVilla.get(p.villaId) ?? 0) + Number(p.amount));
  }

  const residents = villas.map((villa) => {
    const s = snapByVilla.get(villa.id);
    const p = lastPayByVilla.get(villa.id);
    const credit = creditBalances.get(villa.id) ?? 0;
    const cashPaid = cashByVilla.get(villa.id) ?? 0;
    const isExcluded = dashExcludedIds.has(villa.id);
    if (!s) {
      return {
        villaId: villa.id,
        villaNumber: villa.villaNumber,
        ownerName: villa.ownerName,
        amount: 0,
        status: "PENDING" as const,
        dueDate: null,
        paidAt: null,
        receiptNumber: null,
        paymentMode: null,
        transactionId: null,
        ...(credit > 0 ? { advanceCredit: credit } : {}),
        ...(isExcluded ? { isExcluded: true } : {}),
      };
    }
    let status: "PENDING" | "PAID" | "OVERDUE" | "PARTIAL" = "PENDING";
    if (s.status === "PAID") status = "PAID";
    else if (s.status === "PARTIAL") status = "PARTIAL";
    else if (s.status === "OVERDUE") status = "OVERDUE";
    const paidToward = Number(s.paidAmount);
    return {
      villaId: villa.id,
      villaNumber: villa.villaNumber,
      ownerName: villa.ownerName,
      amount: Number(s.expectedAmount),
      ...(paidToward > 0 ? { paidTowardCycle: paidToward } : {}),
      status,
      dueDate: cycle.dueDate,
      paidAt: p?.paymentDate ?? null,
      receiptNumber:
        p?.receiptNumber ?? gatewayByVilla.get(villa.id)?.receiptNumber ?? null,
      paymentMode:
        p?.paymentMode ?? (gatewayVillaIds.has(villa.id) ? "ONLINE" : null),
      transactionId:
        p?.transactionId ?? gatewayByVilla.get(villa.id)?.transactionId ?? null,
      ...(credit > 0 ? { advanceCredit: credit } : {}),
      ...(cashPaid > 0 ? { cashPaidThisCycle: cashPaid } : {}),
      ...(isExcluded ? { isExcluded: true } : {}),
    };
  });

  const activeSnaps = snapshots.filter((s) => !dashExcludedIds.has(s.villaId));
  const excludedCount = snapshots.filter((s) => dashExcludedIds.has(s.villaId)).length;
  const totalExpected = activeSnaps.reduce((sum, s) => sum + Number(s.expectedAmount), 0);
  const collected = activeSnaps.reduce((sum, s) => sum + Number(s.paidAmount), 0);
  const paidCount = activeSnaps.filter((s) => s.status === "PAID").length;
  const overdueCount = activeSnaps.filter((s) => s.status === "OVERDUE").length;
  const partialCount = activeSnaps.filter((s) => s.status === "PARTIAL").length;
  const unpaidCount = activeSnaps.length - paidCount;
  const pendingAmount = Math.max(0, totalExpected - collected);
  const collectionRate =
    totalExpected > 0 ? Math.round((collected / totalExpected) * 100) : 0;

  const paymentHistory = payments.map((p) => ({
    id: p.id,
    villaNumber: p.villa?.villaNumber ?? null,
    ownerName: p.villa?.ownerName ?? null,
    month: p.month,
    year: p.year,
    amount: Number(p.amount),
    paymentDate: p.paymentDate,
    paymentMode: p.paymentMode,
    receiptNumber: p.receiptNumber,
    maintenanceCollectionCycleId: p.maintenanceCollectionCycleId,
  }));

  return {
    cycle: {
      id: cycle.id,
      title: cycle.title,
      periodMonth: cycle.periodMonth,
      periodYear: cycle.periodYear,
      dueDate: cycle.dueDate,
      status: cycle.status,
    },
    month: cycle.periodMonth,
    year: cycle.periodYear,
    residents,
    paymentHistory,
    summary: {
      totalVillas: villas.length,
      paidCount,
      unpaidCount,
      overdueCount,
      partialCount,
      excludedCount,
      totalExpected,
      collected,
      pendingAmount,
      collectionRate,
    },
  };
}
