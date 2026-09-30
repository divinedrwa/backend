import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  loadAppVisibleBillingCyclePeriodKeys,
  maintenanceCollectionBackedByBillingCycleWhere,
} from "../billing-cycle/billing-collection-scope";

type Db = typeof prisma | Prisma.TransactionClient;

export type OutstandingCycle = {
  cycleId: string;
  cycleTitle: string;
  month: number;
  year: number;
  expectedAmount: number;
  baseExpectedAmount: number;
  lateFeeAmount: number;
  paidAmount: number;
  remainingDue: number;
  dueDate: string;
  status: string;
  isOverdue: boolean;
};

export type OutstandingVilla = {
  villaId: string;
  villaNumber: string;
  ownerName: string;
  totalOutstanding: number;
  pendingCycles: OutstandingCycle[];
};

/**
 * Villas with pending maintenance for published, app-visible billing cycles only
 * (draft cycles excluded — same scope as the resident outstanding-dues view).
 * Amounts include any applied late fee. Villas sorted by amount owed, highest first.
 */
export async function computeOutstandingDues(db: Db, societyId: string) {
  const periodKeys = await loadAppVisibleBillingCyclePeriodKeys(db as typeof prisma, societyId);

  const snapshots = await db.villaMaintenanceSnapshot.findMany({
    where: {
      cycle: maintenanceCollectionBackedByBillingCycleWhere(societyId, periodKeys),
      status: { notIn: ["PAID", "WAIVED"] },
    },
    include: {
      cycle: {
        select: { id: true, title: true, periodMonth: true, periodYear: true, dueDate: true },
      },
      villa: { select: { id: true, villaNumber: true, ownerName: true } },
    },
    orderBy: { cycle: { dueDate: "asc" } },
  });

  const villaMap = new Map<string, OutstandingVilla>();
  const now = new Date();
  let totalOutstanding = 0;
  let totalPendingCycles = 0;

  for (const snap of snapshots) {
    const baseExpected = Number(snap.expectedAmount);
    const lateFee = Number(snap.lateFeeAmount ?? 0);
    // Total owed for the cycle includes any applied late fee — consistent with
    // the resident ledger and the financial dashboard (which both add it).
    const expected = baseExpected + lateFee;
    const paid = Number(snap.paidAmount);
    const remaining = expected - paid;
    if (remaining <= 0) continue;

    totalOutstanding += remaining;
    totalPendingCycles += 1;

    const vid = snap.villa.id;
    let entry = villaMap.get(vid);
    if (!entry) {
      entry = {
        villaId: vid,
        villaNumber: snap.villa.villaNumber,
        ownerName: snap.villa.ownerName ?? "",
        totalOutstanding: 0,
        pendingCycles: [],
      };
      villaMap.set(vid, entry);
    }
    entry.totalOutstanding += remaining;

    const isOverdue = snap.status === "OVERDUE" || new Date(snap.cycle.dueDate) < now;

    entry.pendingCycles.push({
      cycleId: snap.cycle.id,
      cycleTitle: snap.cycle.title,
      month: snap.cycle.periodMonth,
      year: snap.cycle.periodYear,
      expectedAmount: expected,
      baseExpectedAmount: baseExpected,
      lateFeeAmount: lateFee,
      paidAmount: paid,
      remainingDue: remaining,
      dueDate: snap.cycle.dueDate.toISOString(),
      status: isOverdue ? "OVERDUE" : snap.status,
      isOverdue,
    });
  }

  const villas = Array.from(villaMap.values()).sort((a, b) => b.totalOutstanding - a.totalOutstanding);

  return { villas, totalOutstanding, villasWithDuesCount: villas.length, totalPendingCycles };
}
