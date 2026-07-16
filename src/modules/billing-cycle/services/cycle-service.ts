import {
  BillingCycle,
  BillingCycleStatus,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  NotificationCategory,
} from "@prisma/client";
import { logger } from "../../../lib/logger";
import { prisma } from "../../../lib/prisma";
import { deriveCycleStatusUtc, isAppVisibleBillingCycle } from "../domain/cycleStatus";
import { resolvePerCycleExpectedTotal, resolveLedgerCycleExpected } from "../domain/amountDue";
import { billingCacheGet, billingCacheSet, billingCacheDel } from "./billing-cache";
import { notifySocietyRoles, notifyUser } from "../../../services/notification.service";
import { RESIDENT_LIKE_ROLES } from "../../../lib/residentLike";
import { residentLikeRoleFilter } from "../../../lib/residentLike";
import { getVillaCreditBalance } from "../../maintenance-management/credit-walker";
import {
  buildPendingDuesFromLedger,
  pendingDuesToCurrentCycleShape,
} from "./resident-pending-dues";

/** Residents and payment flows only see billing cycles after admin publishes them. */
export const publishedBillingCycleFilter = { publishedAt: { not: null } } as const;

export type BillingLedgerCycleRow = {
  cycleId: string;
  cycleKey: string;
  title: string;
  /** Base maintenance for this cycle (before late fee). */
  baseExpectedAmount: number;
  /** Late fee applied for this cycle only. */
  lateFeeAmount: number;
  expectedAmount: number;
  cashPaidAmount: number;
  /** Advance credit applied toward this cycle (not cash received). */
  creditApplied: number;
  paidAmount: number;
  deltaAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  paymentStatus: BillingUserPaymentStatus | "NONE";
  paidAt: string | null;
};

/**
 * Pick the display cycle for the resident maintenance screen.
 *
 * Rule: latest published cycle in the active FY whose payment window is OPEN
 * or CLOSED (UPCOMING and draft cycles stay hidden on the app).
 */
async function resolveDisplayCycleRows(societyId: string, nowUtc: Date): Promise<BillingCycle | null> {
  const activeFYs = await prisma.financialYear.findMany({
    where: { societyId, status: "ACTIVE" },
    orderBy: { startDate: "desc" },
    select: { id: true, startDate: true, endDate: true },
  });

  const currentFY =
    activeFYs.find((fy) => nowUtc >= fy.startDate && nowUtc <= fy.endDate) ??
    activeFYs[0] ??
    null;

  const pickVisible = (rows: BillingCycle[]): BillingCycle | null => {
    const visible = rows.filter((c) => isAppVisibleBillingCycle(nowUtc, c));
    if (visible.length === 0) return null;
    const open = visible.find(
      (c) =>
        deriveCycleStatusUtc(nowUtc, c.paymentStartDate, c.paymentEndDate) ===
        BillingCycleStatus.OPEN,
    );
    return open ?? visible[0]!;
  };

  if (currentFY) {
    const candidates = await prisma.billingCycle.findMany({
      where: { societyId, financialYearId: currentFY.id, ...publishedBillingCycleFilter },
      orderBy: { cycleKey: "desc" },
    });
    const picked = pickVisible(candidates);
    if (picked) return picked;
  }

  const fallbackCandidates = await prisma.billingCycle.findMany({
    where: { societyId, ...publishedBillingCycleFilter },
    orderBy: { cycleKey: "desc" },
  });
  return pickVisible(fallbackCandidates);
}

const DISPLAY_CYCLE_KEY_PREFIX = "billing:dcid:";

export async function invalidateDisplayCycleHint(societyId: string): Promise<void> {
  await billingCacheDel(`${DISPLAY_CYCLE_KEY_PREFIX}${encodeURIComponent(societyId)}`);
}

/** Latest cycleKey in the active FY → fallback to latest cycleKey overall. */
export async function findDisplayCycle(societyId: string, nowUtc = new Date()): Promise<BillingCycle | null> {
  const k = `${DISPLAY_CYCLE_KEY_PREFIX}${encodeURIComponent(societyId)}`;
  const cachedId = await billingCacheGet(k);
  if (cachedId) {
    const c = await prisma.billingCycle.findUnique({ where: { id: cachedId } });
    if (c && c.societyId === societyId && isAppVisibleBillingCycle(nowUtc, c)) {
      return c;
    }
  }

  const c = await resolveDisplayCycleRows(societyId, nowUtc);
  if (c) {
    await billingCacheSet(k, c.id, 120);
  }
  return c;
}

/** Hourly cron: persist enum + invalidate cache hints. */
export async function syncAllBillingCycleStatuses(nowUtc = new Date()): Promise<number> {
  const rows = await prisma.billingCycle.findMany({
    select: { id: true, societyId: true, paymentStartDate: true, paymentEndDate: true, status: true },
  });
  const touched = new Set<string>();
  let updates = 0;
  for (const c of rows) {
    const next = deriveCycleStatusUtc(nowUtc, c.paymentStartDate, c.paymentEndDate);
    if (next !== c.status) {
      await prisma.billingCycle.update({ where: { id: c.id }, data: { status: next } });
      updates++;
    }
    touched.add(c.societyId);
  }
  await Promise.all([...touched].map((s) => invalidateDisplayCycleHint(s)));
  return updates;
}

export async function buildCurrentCycleResponse(input: {
  societyId: string;
  userId: string;
  nowUtc?: Date;
  /** When set, return ledger + window for this cycle (must belong to society). */
  billingCycleId?: string;
}): Promise<Record<string, unknown>> {
  const nowUtc = input.nowUtc ?? new Date();
  const billingSubject = await prisma.user.findFirst({
    where: { id: input.userId, societyId: input.societyId },
    select: { maintenanceBillingRole: true, villaId: true },
  });
  const maintenanceBillingExcluded =
    billingSubject?.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED;

  const pendingDues = maintenanceBillingExcluded
    ? []
    : pendingDuesToCurrentCycleShape(
        await buildPendingDuesFromLedger(input.societyId, input.userId, nowUtc),
      );

  let cycle: BillingCycle | null = null;
  if (input.billingCycleId?.trim()) {
    cycle = await prisma.billingCycle.findFirst({
      where: {
        id: input.billingCycleId.trim(),
        societyId: input.societyId,
        ...publishedBillingCycleFilter,
      },
    });
    if (!cycle) {
      throw new Error("BILLING_CYCLE_NOT_FOUND");
    }
    if (!isAppVisibleBillingCycle(nowUtc, cycle)) {
      throw new Error("BILLING_CYCLE_NOT_FOUND");
    }
  } else {
    cycle = await findDisplayCycle(input.societyId, nowUtc);
  }
  if (!cycle) {
    // Even without an active cycle, compute available credit from the
    // credit-walker (admin-added credit) and the billing ledger (gateway
    // overpayment). Use the larger of the two — they track different sources.
    const ledger = await computeUserBillingLedger(input.societyId, input.userId);
    const ledgerCredit = Math.max(0, ledger.currentBalance);

    let walkerCredit = 0;
    if (billingSubject?.villaId) {
      const activeFY = await prisma.financialYear.findFirst({
        where: { societyId: input.societyId, status: "ACTIVE" },
        select: { id: true },
      });
      if (activeFY) {
        const result = await getVillaCreditBalance(prisma, {
          societyId: input.societyId,
          villaId: billingSubject.villaId,
          financialYearId: activeFY.id,
        });
        walkerCredit = result.creditPool;
      }
    }
    const availableCredit = maintenanceBillingExcluded
      ? 0
      : Math.max(ledgerCredit, walkerCredit);

    return {
      cycleId: null,
      title: null,
      amount: null,
      status: null,
      paymentStartDate: null,
      paymentEndDate: null,
      dueDate: null,
      isPaid: maintenanceBillingExcluded,
      lateFee: null,
      totalDue: null,
      effectiveLateFeeComponent: null,
      availableCredit,
      pendingDues,
      maintenanceBillingRole: billingSubject?.maintenanceBillingRole ?? null,
      maintenanceBillingExcluded,
    };
  }

  const payment = await prisma.userCyclePayment.findUnique({
    where: {
      userId_cycleId: { userId: input.userId, cycleId: cycle.id },
    },
  });
  const ledger = await computeUserBillingLedger(input.societyId, input.userId);
  const currentLedger =
    ledger.cycles.find((row) => row.cycleId === cycle.id) ??
    ({
      cycleId: cycle.id,
      cycleKey: cycle.cycleKey,
      title: cycle.title,
      baseExpectedAmount: Number(cycle.amount),
      lateFeeAmount: 0,
      expectedAmount: Number(cycle.amount),
      cashPaidAmount:
        payment?.paymentStatus === BillingUserPaymentStatus.SUCCESS ? Number(payment?.amountPaid ?? 0) : 0,
      creditApplied: 0,
      paidAmount:
        payment?.paymentStatus === BillingUserPaymentStatus.SUCCESS ? Number(payment?.amountPaid ?? 0) : 0,
      deltaAmount:
        (payment?.paymentStatus === BillingUserPaymentStatus.SUCCESS ? Number(payment?.amountPaid ?? 0) : 0) -
        Number(cycle.amount),
      balanceBefore: ledger.currentBalance,
      balanceAfter: ledger.currentBalance +
        (payment?.paymentStatus === BillingUserPaymentStatus.SUCCESS ? Number(payment?.amountPaid ?? 0) : 0) -
        Number(cycle.amount),
      paymentStatus: payment?.paymentStatus ?? "NONE",
      paidAt: payment?.paidAt?.toISOString() ?? null,
    } as BillingLedgerCycleRow);
  const previousDue = Math.max(0, -currentLedger.balanceBefore);
  const remainingDue = Math.max(
    0,
    currentLedger.expectedAmount - currentLedger.cashPaidAmount - currentLedger.creditApplied,
  );
  const isPaid = remainingDue <= 0.005;

  // Also fetch admin-added credit from the credit-walker so it's visible to
  // the resident even when the billing ledger doesn't capture it.
  let walkerCredit = 0;
  if (billingSubject?.villaId && cycle.financialYearId) {
    const result = await getVillaCreditBalance(prisma, {
      societyId: input.societyId,
      villaId: billingSubject.villaId,
      financialYearId: cycle.financialYearId,
    });
    walkerCredit = result.creditPool;
  }
  // Surplus credit remaining AFTER all obligations (same basis as the
  // no-active-cycle branch). remainingDue above already nets creditApplied,
  // so showing pre-cycle balance here would double-display the same credit;
  // and a genuine leftover surplus stays visible even when the cycle is paid.
  const ledgerSurplus = Math.max(0, ledger.currentBalance);
  const availableCredit = maintenanceBillingExcluded
    ? 0
    : Math.max(ledgerSurplus, walkerCredit);

  const serverStatus = deriveCycleStatusUtc(nowUtc, cycle.paymentStartDate, cycle.paymentEndDate);

  return {
    cycleId: cycle.id,
    title: cycle.title,
    amount: Number(cycle.amount),
    status: serverStatus,
    paymentStartDate: cycle.paymentStartDate.toISOString(),
    paymentEndDate: cycle.paymentEndDate.toISOString(),
    dueDate: cycle.paymentEndDate.toISOString(),
    isPaid: maintenanceBillingExcluded ? true : isPaid,
    lateFee: Number(cycle.lateFee),
    /** Cash still due for this cycle — same as hub pay bar and gateway checkout. */
    totalDue: maintenanceBillingExcluded ? 0 : remainingDue,
    effectiveLateFeeComponent: maintenanceBillingExcluded ? 0 : currentLedger.lateFeeAmount,
    baseExpectedAmount: currentLedger.baseExpectedAmount,
    lateFeeAmount: currentLedger.lateFeeAmount,
    cycleKey: cycle.cycleKey,
    expectedAmount: currentLedger.expectedAmount,
    cashPaidAmount: currentLedger.cashPaidAmount,
    paidAmount: currentLedger.paidAmount,
    deltaAmount: currentLedger.deltaAmount,
    availableCredit,
    remainingDue: maintenanceBillingExcluded ? 0 : remainingDue,
    previousDue: maintenanceBillingExcluded ? 0 : previousDue,
    pendingDues,
    maintenanceBillingRole: billingSubject?.maintenanceBillingRole ?? null,
    maintenanceBillingExcluded,
  };
}

export async function computeUserBillingLedger(
  societyId: string,
  userId: string
): Promise<{ cycles: BillingLedgerCycleRow[]; currentBalance: number }> {
  const user = await prisma.user.findFirst({
    where: { id: userId, societyId },
    select: { villaId: true, maintenanceBillingRole: true },
  });
  const villaId = user?.villaId ?? null;

  const cycles = await prisma.billingCycle.findMany({
    where: { societyId, ...publishedBillingCycleFilter },
    orderBy: [{ cycleKey: "asc" }],
    select: {
      id: true,
      cycleKey: true,
      title: true,
      amount: true,
      lateFee: true,
      paymentEndDate: true,
      gracePeriodDays: true,
      financialYearId: true,
    },
  });
  if (cycles.length === 0) {
    return { cycles: [], currentBalance: 0 };
  }

  if (user?.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED) {
    const rows: BillingLedgerCycleRow[] = cycles.map((c) => ({
      cycleId: c.id,
      cycleKey: c.cycleKey,
      title: c.title,
      baseExpectedAmount: 0,
      lateFeeAmount: 0,
      expectedAmount: 0,
      cashPaidAmount: 0,
      creditApplied: 0,
      paidAmount: 0,
      deltaAmount: 0,
      balanceBefore: 0,
      balanceAfter: 0,
      paymentStatus: "NONE",
      paidAt: null,
    }));
    return { cycles: rows, currentBalance: 0 };
  }

  const payments = await prisma.userCyclePayment.findMany({
    where: { userId, cycleId: { in: cycles.map((c) => c.id) } },
    select: {
      cycleId: true,
      amountPaid: true,
      paymentStatus: true,
      paidAt: true,
    },
  });
  const payMap = new Map(payments.map((p) => [p.cycleId, p]));

  /** When society maintenance collection snapshots exist for this villa, they are the source of truth for expected/paid (Maintenance Payment Management UI). */
  const billingCycleIdToSnap = new Map<
    string,
    {
      expectedAmount: unknown;
      paidAmount: unknown;
      status: string;
      lateFeeAmount: unknown;
      lateFeeAppliedAt: Date | null;
    }
  >();
  const billingCycleIdToMcId = new Map<string, string>();
  let cashByMcId = new Map<string, number>();

  const waivers = await prisma.billingLateFeeWaiver.findMany({
    where: { userId, cycleId: { in: cycles.map((c) => c.id) } },
    select: { cycleId: true },
  });
  const waivedCycleIds = new Set(waivers.map((w) => w.cycleId));
  const nowUtc = new Date();

  const fyPairs = cycles
    .filter((c): c is (typeof c) & { financialYearId: string } => Boolean(c.financialYearId))
    .map((c) => ({ financialYearId: c.financialYearId, periodKey: c.cycleKey }));

  if (villaId && fyPairs.length > 0) {
    const maintenanceCycles = await prisma.maintenanceCollectionCycle.findMany({
      where: { OR: fyPairs },
      select: { id: true, financialYearId: true, periodKey: true },
    });
    const mcIdByKey = new Map(
      maintenanceCycles.map((m) => [`${m.financialYearId}:${m.periodKey}`, m.id] as const),
    );
    const mIds = [...new Set(maintenanceCycles.map((m) => m.id))];
    if (mIds.length > 0) {
      const [snaps, cashAgg] = await Promise.all([
        prisma.villaMaintenanceSnapshot.findMany({
          where: { villaId, cycleId: { in: mIds } },
          select: {
            cycleId: true,
            expectedAmount: true,
            paidAmount: true,
            status: true,
            lateFeeAmount: true,
            lateFeeAppliedAt: true,
          },
        }),
        prisma.maintenancePayment.groupBy({
          by: ["maintenanceCollectionCycleId"],
          where: { societyId, villaId, maintenanceCollectionCycleId: { in: mIds } },
          _sum: { amount: true },
        }),
      ]);
      const snapByMcId = new Map(snaps.map((s) => [s.cycleId, s]));
      cashByMcId = new Map<string, number>();
      for (const row of cashAgg) {
        if (row.maintenanceCollectionCycleId) {
          cashByMcId.set(row.maintenanceCollectionCycleId, Number(row._sum.amount || 0));
        }
      }
      for (const c of cycles) {
        if (!c.financialYearId) continue;
        const mcId = mcIdByKey.get(`${c.financialYearId}:${c.cycleKey}`);
        if (!mcId) continue;
        const snap = snapByMcId.get(mcId);
        if (snap) {
          billingCycleIdToSnap.set(c.id, snap);
          billingCycleIdToMcId.set(c.id, mcId);
        }
      }
    }
  }

  let rollingBalance = 0;
  const rows: BillingLedgerCycleRow[] = [];
  for (const c of cycles) {
    const p = payMap.get(c.id);
    const snap = billingCycleIdToSnap.get(c.id);

    const waived = waivedCycleIds.has(c.id);
    const { baseAmount, lateFeeAmount, totalExpected } = snap
      ? resolveLedgerCycleExpected(c, snap, nowUtc, waived)
      : resolvePerCycleExpectedTotal(c, null, nowUtc, waived);

    let expectedAmount: number;
    let cashPaidAmount: number;
    let creditApplied: number;
    let paymentStatus: BillingUserPaymentStatus | "NONE";
    let paidAt: string | null;

    if (snap) {
      expectedAmount = totalExpected;
      let snapPaid = Number(snap.paidAmount);
      if (snap.status === "WAIVED") {
        snapPaid = expectedAmount;
      }
      const gatewayPaid =
        p?.paymentStatus === BillingUserPaymentStatus.SUCCESS ? Number(p.amountPaid) : 0;
      const mcId = billingCycleIdToMcId.get(c.id);
      const actualCash = mcId ? (cashByMcId.get(mcId) ?? 0) : gatewayPaid;
      cashPaidAmount = actualCash;

      const creditFromPrior = Math.max(0, Math.min(expectedAmount, rollingBalance));
      const totalSettled = Math.min(
        expectedAmount,
        Math.max(snapPaid, actualCash + creditFromPrior),
      );
      creditApplied = Math.max(0, Math.min(totalSettled, totalSettled - actualCash));

      const effectivelyPaid =
        snap.status === "PAID" ||
        snap.status === "WAIVED" ||
        totalSettled >= expectedAmount - 0.005;

      if (effectivelyPaid) {
        paymentStatus = BillingUserPaymentStatus.SUCCESS;
      } else if (actualCash > 0.005 || snap.status === "PARTIAL") {
        paymentStatus = BillingUserPaymentStatus.PENDING;
      } else {
        paymentStatus = p?.paymentStatus ?? "NONE";
      }
      paidAt = p?.paidAt?.toISOString() ?? null;
    } else {
      expectedAmount = totalExpected;
      cashPaidAmount =
        p?.paymentStatus === BillingUserPaymentStatus.SUCCESS ? Number(p.amountPaid) : 0;
      creditApplied = Math.max(0, Math.min(expectedAmount, rollingBalance));
      paymentStatus = p?.paymentStatus ?? "NONE";
      paidAt = p?.paidAt?.toISOString() ?? null;
    }

    const balanceBefore = rollingBalance;
    // paidAmount is capped at expected — cycle overpayment lives in the
    // rolling balance, not the row.
    const paidAmount = Math.min(expectedAmount, Math.max(0, cashPaidAmount + creditApplied));
    // Conservation: balance += cash − expected, ALWAYS. Prior credit is
    // consumed (or arrears deepened) implicitly through the running balance.
    // Never reset the balance when a cycle is covered by its own cash — that
    // silently destroys both carried-forward credit AND unpaid arrears.
    rollingBalance = rollingBalance + cashPaidAmount - expectedAmount;
    const deltaAmount = paidAmount - expectedAmount;
    rows.push({
      cycleId: c.id,
      cycleKey: c.cycleKey,
      title: c.title,
      baseExpectedAmount: baseAmount,
      lateFeeAmount,
      expectedAmount,
      cashPaidAmount,
      creditApplied,
      paidAmount,
      deltaAmount,
      balanceBefore,
      balanceAfter: rollingBalance,
      paymentStatus,
      paidAt,
    });
  }

  return { cycles: rows, currentBalance: rollingBalance };
}

export async function runBillingReminderJobs(nowUtc = new Date()): Promise<void> {
  const cycles = await prisma.billingCycle.findMany({
    where: {},
    include: { society: { select: { name: true } } },
    take: 500,
  });

  for (const c of cycles) {
    const status = deriveCycleStatusUtc(nowUtc, c.paymentStartDate, c.paymentEndDate);

    // Skip cron notifications for unpublished (draft) cycles
    if (!c.publishedAt) continue;

    if (status === BillingCycleStatus.OPEN && !c.windowOpenNotifiedAt) {
      // Persist timestamp BEFORE sending push — if cron crashes mid-send, a
      // missed push is less harmful than duplicate pushes to all residents.
      await prisma.billingCycle.update({
        where: { id: c.id },
        data: { windowOpenNotifiedAt: nowUtc },
      });
      try {
        await notifySocietyRoles({
          societyId: c.societyId,
          roles: [...RESIDENT_LIKE_ROLES],
          category: NotificationCategory.MAINTENANCE,
          title: "Maintenance payment window open",
          body: `You can pay "${c.title}" until ${c.paymentEndDate.toISOString()}.`,
          data: { type: "billing_window_open", cycleId: c.id },
        });
      } catch {
        /* optional */
      }
    }

    const msLeft = c.paymentEndDate.getTime() - nowUtc.getTime();
    const oneDay = 24 * 60 * 60 * 1000;
    if (status === BillingCycleStatus.OPEN && msLeft > 0 && msLeft <= oneDay && !c.dueReminderSentAt) {
      await prisma.billingCycle.update({
        where: { id: c.id },
        data: { dueReminderSentAt: nowUtc },
      });
      try {
        await notifySocietyRoles({
          societyId: c.societyId,
          roles: [...RESIDENT_LIKE_ROLES],
          category: NotificationCategory.MAINTENANCE,
          title: "Maintenance due soon",
          body: `Pay "${c.title}" before ${c.paymentEndDate.toISOString()} to avoid late fees.`,
          data: { type: "billing_due_reminder", cycleId: c.id },
        });
      } catch {
        /* optional */
      }
    }
  }

  // IST is UTC+5:30 (fixed offset, no DST). Avoid toLocaleString which is
  // implementation-defined and may not round-trip through new Date().
  const indiaNow = new Date(nowUtc.getTime() + 5.5 * 60 * 60 * 1000);
  const slotHour = indiaNow.getHours();
  const runSlot = slotHour === 9 || slotHour === 19;
  if (!runSlot) {
    return;
  }
  const slot = slotHour === 9 ? "morning" : "evening";
  const dateKey = `${indiaNow.getFullYear()}-${String(indiaNow.getMonth() + 1).padStart(2, "0")}-${String(
    indiaNow.getDate(),
  ).padStart(2, "0")}`;

  const societies = [...new Set(cycles.map((c) => c.societyId))];
  for (const societyId of societies) {
    const overdueCycles = cycles
      .filter((c) => c.societyId === societyId)
      .filter((c) => {
        const graceEndsAtMs =
          c.paymentEndDate.getTime() + c.gracePeriodDays * 24 * 60 * 60 * 1000;
        return nowUtc.getTime() > graceEndsAtMs;
      })
      .sort((a, b) => a.paymentEndDate.getTime() - b.paymentEndDate.getTime());
    if (overdueCycles.length === 0) continue;

    const residents = await prisma.user.findMany({
      where: {
        societyId,
        isActive: true,
        villaId: { not: null },
        maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
        ...residentLikeRoleFilter,
      },
      select: { id: true, name: true },
    });
    if (residents.length === 0) continue;

    const cycleIds = overdueCycles.map((c) => c.id);
    const payments = await prisma.userCyclePayment.findMany({
      where: {
        cycleId: { in: cycleIds },
        paymentStatus: BillingUserPaymentStatus.SUCCESS,
      },
      select: { userId: true, cycleId: true },
    });
    const paidByUser = new Map<string, Set<string>>();
    for (const p of payments) {
      if (!p.userId) continue;
      if (!paidByUser.has(p.userId)) {
        paidByUser.set(p.userId, new Set());
      }
      paidByUser.get(p.userId)!.add(p.cycleId);
    }

    for (const resident of residents) {
      const sentKey = `billing:grace-reminder:${societyId}:${resident.id}:${dateKey}:${slot}`;
      const alreadySent = await billingCacheGet(sentKey);
      if (alreadySent) continue;

      const ledger = await computeUserBillingLedger(societyId, resident.id);
      const ledgerByCycleId = new Map(ledger.cycles.map((row) => [row.cycleId, row]));
      const paidSet = paidByUser.get(resident.id) ?? new Set<string>();
      // Remaining due must net BOTH cash and applied advance credit — a cycle
      // fully settled from credit shows PAID in the app and must not be nagged.
      const cycleRemaining = (c: (typeof overdueCycles)[number]): number => {
        const row = ledgerByCycleId.get(c.id);
        if (row) {
          return Math.max(0, row.expectedAmount - row.cashPaidAmount - row.creditApplied);
        }
        return paidSet.has(c.id) ? 0 : Number(c.amount);
      };
      const pendingCycles = overdueCycles.filter((c) => cycleRemaining(c) > 0.005);
      if (pendingCycles.length === 0) continue;

      const totalDue = pendingCycles.reduce((sum, c) => sum + cycleRemaining(c), 0);
      const monthsList = pendingCycles.map((c) => c.cycleKey).join(", ");
      const title = "Maintenance dues pending";
      const body =
        pendingCycles.length === 1
          ? `Your ${pendingCycles[0].cycleKey} maintenance is still unpaid after grace period. Please pay soon.`
          : `You have ${pendingCycles.length} unpaid maintenance cycles (${monthsList}). Please clear dues.`;

      // Set cache key BEFORE sending push to prevent duplicates on crash/restart.
      await billingCacheSet(sentKey, "1", 16 * 60 * 60);
      try {
        await notifyUser(
          resident.id,
          {
            title,
            body,
            data: {
              type: "BILLING_GRACE_REMINDER",
              pendingCycleCount: String(pendingCycles.length),
              totalDue: totalDue.toFixed(2),
            },
          },
          { category: NotificationCategory.MAINTENANCE },
        );
      } catch (pushErr) {
        logger.error({ err: pushErr }, "[billing-reminder] push send failed");
      }
    }
  }
}
