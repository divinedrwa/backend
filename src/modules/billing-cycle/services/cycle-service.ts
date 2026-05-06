import {
  BillingCycle,
  BillingCycleStatus,
  NotificationCategory,
  BillingUserPaymentStatus,
  UserRole,
} from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { deriveCycleStatusUtc } from "../domain/cycleStatus";
import { computeAmountDueForCycle } from "../domain/amountDue";
import { billingCacheGet, billingCacheSet, billingCacheDel } from "./billing-cache";
import { notifySociety, notifyUser } from "../../../services/notification.service";

export type BillingLedgerCycleRow = {
  cycleId: string;
  cycleKey: string;
  title: string;
  expectedAmount: number;
  cashPaidAmount: number;
  paidAmount: number;
  deltaAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  paymentStatus: BillingUserPaymentStatus | "NONE";
  paidAt: string | null;
};

/** Pick canonical “current” cycle from calendar windows alone (never trust stale DB enum). */
function pickDisplayCycle(cycles: BillingCycle[], nowUtc: Date): BillingCycle | null {
  let openCycle: BillingCycle | null = null;
  let upcomingCycle: BillingCycle | null = null;
  let closedCycle: BillingCycle | null = null;

  let upcomingClosest: number | null = null;

  for (const c of cycles) {
    const s = deriveCycleStatusUtc(nowUtc, c.paymentStartDate, c.paymentEndDate);
    if (s === BillingCycleStatus.OPEN) {
      if (
        !openCycle ||
        c.paymentEndDate.getTime() > openCycle.paymentEndDate.getTime()
      ) {
        openCycle = c;
      }
    } else if (s === BillingCycleStatus.UPCOMING) {
      const start = c.paymentStartDate.getTime();
      if (upcomingClosest === null || start < upcomingClosest) {
        upcomingClosest = start;
        upcomingCycle = c;
      }
    } else {
      const end = c.paymentEndDate.getTime();
      if (!closedCycle || end > closedCycle.paymentEndDate.getTime()) {
        closedCycle = c;
      }
    }
  }

  return openCycle ?? upcomingCycle ?? closedCycle;
}

async function resolveDisplayCycleRows(societyId: string, nowUtc: Date): Promise<BillingCycle | null> {
  const cycles = await prisma.billingCycle.findMany({
    where: { societyId },
    orderBy: { paymentStartDate: "desc" },
    take: 60,
  });
  const chosen = pickDisplayCycle(cycles, nowUtc);
  return chosen ?? null;
}

const DISPLAY_CYCLE_KEY_PREFIX = "billing:dcid:";

export async function invalidateDisplayCycleHint(societyId: string): Promise<void> {
  await billingCacheDel(`${DISPLAY_CYCLE_KEY_PREFIX}${encodeURIComponent(societyId)}`);
}

/** OPEN → UPCOMING → last CLOSED, derived from timestamps (matches cron-persisted status when synced). */
export async function findDisplayCycle(societyId: string, nowUtc = new Date()): Promise<BillingCycle | null> {
  const k = `${DISPLAY_CYCLE_KEY_PREFIX}${encodeURIComponent(societyId)}`;
  const cachedId = await billingCacheGet(k);
  if (cachedId) {
    const c = await prisma.billingCycle.findUnique({ where: { id: cachedId } });
    if (c && c.societyId === societyId) {
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
}): Promise<Record<string, unknown>> {
  const nowUtc = input.nowUtc ?? new Date();
  const pendingRows = await prisma.billingCycle.findMany({
    where: { societyId: input.societyId },
    orderBy: { paymentEndDate: "asc" },
    take: 60,
  });

  const pendingPayments = await prisma.userCyclePayment.findMany({
    where: {
      userId: input.userId,
      cycleId: { in: pendingRows.map((c) => c.id) },
      paymentStatus: BillingUserPaymentStatus.SUCCESS,
    },
    select: { cycleId: true },
  });
  const paidCycleIds = new Set(pendingPayments.map((p) => p.cycleId));
  const pendingDues = pendingRows
    .filter((c) => !paidCycleIds.has(c.id))
    .map((c) => {
      const isGraceOver =
        nowUtc.getTime() >
        c.paymentEndDate.getTime() + c.gracePeriodDays * 24 * 60 * 60 * 1000;
      const status = deriveCycleStatusUtc(nowUtc, c.paymentStartDate, c.paymentEndDate);
      return {
        cycleId: c.id,
        cycleKey: c.cycleKey,
        title: c.title,
        amount: Number(c.amount),
        paymentEndDate: c.paymentEndDate.toISOString(),
        gracePeriodDays: c.gracePeriodDays,
        isGraceOver,
        status,
      };
    });

  const cycle = await findDisplayCycle(input.societyId, nowUtc);
  if (!cycle) {
    return {
      cycleId: null,
      title: null,
      amount: null,
      status: null,
      paymentStartDate: null,
      paymentEndDate: null,
      dueDate: null,
      isPaid: false,
      lateFee: null,
      totalDue: null,
      effectiveLateFeeComponent: null,
      pendingDues,
    };
  }

  const waiver = await prisma.billingLateFeeWaiver.findUnique({
    where: {
      cycleId_userId: { cycleId: cycle.id, userId: input.userId },
    },
  });
  const waived = Boolean(waiver);

  const due = computeAmountDueForCycle(cycle, nowUtc, waived);

  const payment = await prisma.userCyclePayment.findUnique({
    where: {
      userId_cycleId: { userId: input.userId, cycleId: cycle.id },
    },
  });
  const isPaid = payment?.paymentStatus === BillingUserPaymentStatus.SUCCESS;
  const ledger = await computeUserBillingLedger(input.societyId, input.userId);
  const currentLedger =
    ledger.cycles.find((row) => row.cycleId === cycle.id) ??
    ({
      cycleId: cycle.id,
      cycleKey: cycle.cycleKey,
      title: cycle.title,
      expectedAmount: Number(cycle.amount),
      cashPaidAmount: isPaid ? Number(payment?.amountPaid ?? 0) : 0,
      paidAmount: isPaid ? Number(payment?.amountPaid ?? 0) : 0,
      deltaAmount: (isPaid ? Number(payment?.amountPaid ?? 0) : 0) - Number(cycle.amount),
      balanceBefore: 0,
      balanceAfter: 0,
      paymentStatus: payment?.paymentStatus ?? "NONE",
      paidAt: payment?.paidAt?.toISOString() ?? null,
    } as BillingLedgerCycleRow);
  const availableCredit = Math.max(0, currentLedger.balanceBefore);
  const previousDue = Math.max(0, -currentLedger.balanceBefore);
  const remainingDue = Math.max(0, currentLedger.expectedAmount - currentLedger.paidAmount);

  const serverStatus = deriveCycleStatusUtc(nowUtc, cycle.paymentStartDate, cycle.paymentEndDate);

  return {
    cycleId: cycle.id,
    title: cycle.title,
    amount: Number(cycle.amount),
    status: serverStatus,
    paymentStartDate: cycle.paymentStartDate.toISOString(),
    paymentEndDate: cycle.paymentEndDate.toISOString(),
    dueDate: cycle.paymentEndDate.toISOString(),
    isPaid,
    lateFee: Number(cycle.lateFee),
    totalDue: due.totalDue,
    effectiveLateFeeComponent: due.lateFeeAmount,
    cycleKey: cycle.cycleKey,
    expectedAmount: currentLedger.expectedAmount,
      cashPaidAmount: currentLedger.cashPaidAmount,
    paidAmount: currentLedger.paidAmount,
    deltaAmount: currentLedger.deltaAmount,
    availableCredit,
    remainingDue,
    previousDue,
    pendingDues,
  };
}

export async function computeUserBillingLedger(
  societyId: string,
  userId: string
): Promise<{ cycles: BillingLedgerCycleRow[]; currentBalance: number }> {
  const cycles = await prisma.billingCycle.findMany({
    where: { societyId },
    orderBy: [{ cycleKey: "asc" }],
    select: { id: true, cycleKey: true, title: true, amount: true },
  });
  if (cycles.length === 0) {
    return { cycles: [], currentBalance: 0 };
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

  let rollingBalance = 0;
  const rows: BillingLedgerCycleRow[] = [];
  for (const c of cycles) {
    const p = payMap.get(c.id);
    const expectedAmount = Number(c.amount);
    const cashPaidAmount =
      p?.paymentStatus === BillingUserPaymentStatus.SUCCESS ? Number(p.amountPaid) : 0;
    const balanceBefore = rollingBalance;
    const creditApplied = Math.max(0, Math.min(expectedAmount, balanceBefore));
    const paidAmount = Math.min(expectedAmount, creditApplied + cashPaidAmount);
    const deltaAmount = paidAmount - expectedAmount;
    rollingBalance = rollingBalance + cashPaidAmount - expectedAmount;
    rows.push({
      cycleId: c.id,
      cycleKey: c.cycleKey,
      title: c.title,
      expectedAmount,
      cashPaidAmount,
      paidAmount,
      deltaAmount,
      balanceBefore,
      balanceAfter: rollingBalance,
      paymentStatus: p?.paymentStatus ?? "NONE",
      paidAt: p?.paidAt?.toISOString() ?? null,
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

    if (status === BillingCycleStatus.OPEN && !c.windowOpenNotifiedAt) {
      try {
        await notifySociety(
          c.societyId,
          {
            title: "Maintenance payment window open",
            body: `You can pay "${c.title}" until ${c.paymentEndDate.toISOString()}.`,
            data: { type: "billing_window_open", cycleId: c.id },
          },
          UserRole.RESIDENT
        );
      } catch {
        /* optional */
      }
      await prisma.billingCycle.update({
        where: { id: c.id },
        data: { windowOpenNotifiedAt: nowUtc },
      });
    }

    const msLeft = c.paymentEndDate.getTime() - nowUtc.getTime();
    const oneDay = 24 * 60 * 60 * 1000;
    if (status === BillingCycleStatus.OPEN && msLeft > 0 && msLeft <= oneDay && !c.dueReminderSentAt) {
      try {
        await notifySociety(
          c.societyId,
          {
            title: "Maintenance due soon",
            body: `Pay "${c.title}" before ${c.paymentEndDate.toISOString()} to avoid late fees.`,
            data: { type: "billing_due_reminder", cycleId: c.id },
          },
          UserRole.RESIDENT
        );
      } catch {
        /* optional */
      }
      await prisma.billingCycle.update({
        where: { id: c.id },
        data: { dueReminderSentAt: nowUtc },
      });
    }
  }

  const indiaNow = new Date(nowUtc.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
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
        role: UserRole.RESIDENT,
        isActive: true,
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
      if (!paidByUser.has(p.userId)) {
        paidByUser.set(p.userId, new Set());
      }
      paidByUser.get(p.userId)!.add(p.cycleId);
    }

    for (const resident of residents) {
      const sentKey = `billing:grace-reminder:${societyId}:${resident.id}:${dateKey}:${slot}`;
      const alreadySent = await billingCacheGet(sentKey);
      if (alreadySent) continue;

      const paidSet = paidByUser.get(resident.id) ?? new Set<string>();
      const pendingCycles = overdueCycles.filter((c) => !paidSet.has(c.id));
      if (pendingCycles.length === 0) continue;

      const ledger = await computeUserBillingLedger(societyId, resident.id);
      const ledgerByCycleId = new Map(ledger.cycles.map((row) => [row.cycleId, row]));
      const totalDue = pendingCycles.reduce((sum, c) => {
        const row = ledgerByCycleId.get(c.id);
        const remaining = row ? Math.max(0, row.expectedAmount - row.paidAmount) : Number(c.amount);
        return sum + remaining;
      }, 0);
      const monthsList = pendingCycles.map((c) => c.cycleKey).join(", ");
      const title = "Maintenance dues pending";
      const body =
        pendingCycles.length === 1
          ? `Your ${pendingCycles[0].cycleKey} maintenance is still unpaid after grace period. Please pay soon.`
          : `You have ${pendingCycles.length} unpaid maintenance cycles (${monthsList}). Please clear dues.`;

      for (const dueCycle of pendingCycles) {
        const noticeKey = `billing:grace-notice:${societyId}:${resident.id}:${dueCycle.id}:${dateKey}`;
        const noticeSent = await billingCacheGet(noticeKey);
        if (noticeSent) continue;
        try {
          await prisma.notice.create({
            data: {
              societyId,
              title: `Maintenance due: ${dueCycle.cycleKey}`,
              content: `Maintenance for ${dueCycle.cycleKey} is unpaid after grace period. Amount due: Rs. ${Number(
                dueCycle.amount,
              ).toFixed(0)}.`,
              category: "MAINTENANCE",
              priority: "HIGH",
              recipients: {
                create: {
                  userId: resident.id,
                },
              },
            },
          });
          await billingCacheSet(noticeKey, "1", 36 * 60 * 60);
        } catch (noticeErr) {
          // eslint-disable-next-line no-console
          console.error("[billing-reminder] notice create failed:", noticeErr);
        }
      }

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
        // eslint-disable-next-line no-console
        console.error("[billing-reminder] push send failed:", pushErr);
      }

      await billingCacheSet(sentKey, "1", 16 * 60 * 60);
    }
  }
}
