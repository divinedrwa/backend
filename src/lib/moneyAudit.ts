import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { auditFromRequest } from "../services/audit.service";
import { getVillaCreditBalance } from "../modules/maintenance-management/credit-walker";

type Db = Prisma.TransactionClient | typeof import("./prisma").prisma;

/** Ledger state captured before/after an admin money mutation (A5). */
export type VillaLedgerSnapshot = {
  villaId: string;
  cycleId?: string;
  expectedAmount?: number;
  paidAmount?: number;
  status?: string;
  creditPool?: number;
  cashInCycle?: number;
};

export async function captureVillaLedgerSnapshot(
  db: Db,
  params: {
    societyId: string;
    villaId: string;
    cycleId?: string;
    financialYearId?: string;
  },
): Promise<VillaLedgerSnapshot> {
  const snap = params.cycleId
    ? await db.villaMaintenanceSnapshot.findUnique({
        where: {
          cycleId_villaId: { cycleId: params.cycleId, villaId: params.villaId },
        },
        select: {
          expectedAmount: true,
          paidAmount: true,
          status: true,
        },
      })
    : null;

  let creditPool: number | undefined;
  if (params.financialYearId) {
    const bal = await getVillaCreditBalance(db, {
      societyId: params.societyId,
      villaId: params.villaId,
      financialYearId: params.financialYearId,
    });
    creditPool = bal.creditPool;
  }

  let cashInCycle: number | undefined;
  if (params.cycleId) {
    const payments = await db.maintenancePayment.findMany({
      where: {
        societyId: params.societyId,
        villaId: params.villaId,
        maintenanceCollectionCycleId: params.cycleId,
        reversedAt: null,
      },
      select: { amount: true },
    });
    cashInCycle = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  }

  return {
    villaId: params.villaId,
    cycleId: params.cycleId,
    expectedAmount: snap ? Number(snap.expectedAmount) : undefined,
    paidAmount: snap ? Number(snap.paidAmount) : undefined,
    status: snap?.status,
    creditPool,
    cashInCycle,
  };
}

/** Persist audit row with structured before/after ledger snapshots. */
export function auditMoneyMutation(
  req: Request,
  entry: {
    societyId: string;
    adminId: string;
    action: string;
    entityType: string;
    entityId?: string;
    before: VillaLedgerSnapshot;
    after: VillaLedgerSnapshot;
    extra?: Record<string, unknown>;
  },
): void {
  auditFromRequest(req, {
    societyId: entry.societyId,
    adminId: entry.adminId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: {
      before: entry.before,
      after: entry.after,
      ...entry.extra,
    },
  });
}
