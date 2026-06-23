import { BillingPaymentSource, BillingUserPaymentStatus } from "@prisma/client";
import { prisma } from "./prisma";

type FeePayload = {
  platformFee?: number;
  platformFeeGst?: number;
  platformFeePaise?: number;
  platformFeeGstPaise?: number;
};

function readNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function feesFromPayload(payload: unknown): { fee: number; gst: number } {
  if (!payload || typeof payload !== "object") return { fee: 0, gst: 0 };
  const p = payload as FeePayload;
  let fee = readNumber(p.platformFee);
  let gst = readNumber(p.platformFeeGst);
  if (fee === 0 && gst === 0) {
    const feePaise = readNumber(p.platformFeePaise);
    const gstPaise = readNumber(p.platformFeeGstPaise);
    if (feePaise > 0 || gstPaise > 0) {
      fee = feePaise / 100;
      gst = gstPaise / 100;
    }
  }
  return { fee, gst };
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type PlatformRevenueResult = {
  totalRevenue: number;
  byMonth: Array<{ month: string; revenue: number }>;
  bySociety: Array<{ societyId: string; societyName: string; revenue: number }>;
};

export async function aggregatePlatformRevenue(): Promise<PlatformRevenueResult> {
  const orderLogs = await prisma.billingPaymentLog.findMany({
    where: { status: "create_order" },
    select: {
      societyId: true,
      userId: true,
      cycleId: true,
      requestPayload: true,
      createdAt: true,
      society: { select: { name: true } },
    },
  });

  const successPayments = await prisma.userCyclePayment.findMany({
    where: {
      paymentStatus: BillingUserPaymentStatus.SUCCESS,
      source: BillingPaymentSource.GATEWAY,
    },
    select: { userId: true, cycleId: true, paidAt: true, createdAt: true },
  });

  const successKeys = new Set(
    successPayments.map((p) => `${p.userId ?? ""}:${p.cycleId}`),
  );
  const paidAtByKey = new Map(
    successPayments.map((p) => [
      `${p.userId ?? ""}:${p.cycleId}`,
      p.paidAt ?? p.createdAt,
    ]),
  );

  const byMonthMap = new Map<string, number>();
  const bySocietyMap = new Map<string, { name: string; revenue: number }>();
  let totalRevenue = 0;

  for (const log of orderLogs) {
    const key = `${log.userId}:${log.cycleId}`;
    if (!successKeys.has(key)) continue;

    const { fee, gst } = feesFromPayload(log.requestPayload);
    const revenue = fee + gst;
    if (revenue <= 0) continue;

    totalRevenue += revenue;
    const paidAt = paidAtByKey.get(key) ?? log.createdAt;
    const mk = monthKey(paidAt);
    byMonthMap.set(mk, (byMonthMap.get(mk) ?? 0) + revenue);

    if (log.societyId) {
      const existing = bySocietyMap.get(log.societyId) ?? {
        name: log.society?.name ?? log.societyId,
        revenue: 0,
      };
      existing.revenue += revenue;
      bySocietyMap.set(log.societyId, existing);
    }
  }

  const byMonth = [...byMonthMap.entries()]
    .map(([month, revenue]) => ({ month, revenue: Math.round(revenue * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const bySociety = [...bySocietyMap.entries()]
    .map(([societyId, row]) => ({
      societyId,
      societyName: row.name,
      revenue: Math.round(row.revenue * 100) / 100,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    byMonth,
    bySociety,
  };
}
