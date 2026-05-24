import crypto from "crypto";
import { PaymentMode, Prisma } from "@prisma/client";
import { applyVillaCreditAcrossSnapshots } from "../maintenance-management/credit-walker";
import { refreshSnapshotStatus } from "../maintenance-management/snapshot-helpers";

type TxClient = Prisma.TransactionClient;

type PaymentRow = {
  id: string;
  userId: string | null;
  cycleId: string;
  cycle: { societyId: string; id: string };
};

/**
 * Shared ledger sync logic used by both Razorpay and PhonePe webhooks.
 * Writes VillaMaintenanceSnapshot, Maintenance, MaintenancePayment, and
 * runs the credit walker — the exact same block that was in billing-webhook.ts.
 */
export async function syncLedgerForPayment(
  tx: TxClient,
  row: PaymentRow,
  amountPaidNum: number,
  paidAt: Date,
  paymentMode: PaymentMode,
  remarks: string,
): Promise<void> {
  const billingCycle = await tx.billingCycle.findUnique({
    where: { id: row.cycleId },
    select: { cycleKey: true, financialYearId: true, societyId: true },
  });

  const user = row.userId
    ? await tx.user.findUnique({
        where: { id: row.userId },
        select: { villaId: true },
      })
    : null;

  if (!billingCycle?.financialYearId || !user?.villaId) return;

  const maintenanceCycle = await tx.maintenanceCollectionCycle.findFirst({
    where: {
      societyId: billingCycle.societyId,
      financialYearId: billingCycle.financialYearId,
      periodKey: billingCycle.cycleKey,
    },
  });

  if (!maintenanceCycle) return;

  // Lock the snapshot row to prevent concurrent calls from
  // reading the same paidAmount and double-counting.
  const [snapshot] = await tx.$queryRawUnsafe<
    { id: string; expectedAmount: string; paidAmount: string }[]
  >(
    `SELECT id, "expectedAmount"::text, "paidAmount"::text FROM "VillaMaintenanceSnapshot" WHERE "cycleId" = $1 AND "villaId" = $2 FOR UPDATE`,
    maintenanceCycle.id,
    user.villaId,
  );

  if (snapshot) {
    const expected = Number(snapshot.expectedAmount);
    const paidSoFar = Number(snapshot.paidAmount);
    const appliedToCycle = Math.max(0, Math.min(amountPaidNum, expected - paidSoFar));
    const newPaid = paidSoFar + appliedToCycle;
    const snapStatus = refreshSnapshotStatus(expected, newPaid, maintenanceCycle.dueDate);

    // Upsert the legacy Maintenance row so financial-dashboard stays in sync.
    const maintenanceRow = await tx.maintenance.upsert({
      where: {
        villaId_month_year: {
          villaId: user.villaId,
          month: maintenanceCycle.periodMonth,
          year: maintenanceCycle.periodYear,
        },
      },
      create: {
        societyId: billingCycle.societyId,
        villaId: user.villaId,
        month: maintenanceCycle.periodMonth,
        year: maintenanceCycle.periodYear,
        amount: snapshot.expectedAmount,
        dueDate: maintenanceCycle.dueDate,
        status:
          snapStatus === "PAID"
            ? "PAID"
            : snapStatus === "OVERDUE"
              ? "OVERDUE"
              : "PENDING",
      },
      update: {
        amount: snapshot.expectedAmount,
        dueDate: maintenanceCycle.dueDate,
        status:
          snapStatus === "PAID"
            ? "PAID"
            : snapStatus === "OVERDUE"
              ? "OVERDUE"
              : "PENDING",
      },
    });

    // Record the full amount as a MaintenancePayment row — the cash
    // ledger that financial-dashboard reads for allTimeCollected /
    // currentFundBalance.
    if (amountPaidNum > 0.005) {
      await tx.maintenancePayment.create({
        data: {
          societyId: billingCycle.societyId,
          villaId: user.villaId,
          maintenanceId: maintenanceRow.id,
          month: maintenanceCycle.periodMonth,
          year: maintenanceCycle.periodYear,
          amount: new Prisma.Decimal(amountPaidNum),
          paymentDate: paidAt,
          paymentMode,
          receiptNumber: `RCP-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          remarks,
          maintenanceCollectionCycleId: maintenanceCycle.id,
          villaMaintenanceSnapshotId: snapshot.id,
        },
      });
    }

    await tx.villaMaintenanceSnapshot.update({
      where: { id: snapshot.id },
      data: {
        paidAmount: new Prisma.Decimal(newPaid),
        status: snapStatus,
      },
    });
  }

  // Reconcile snapshots up to this cycle so advance credit is
  // accounted for (mirrors mark-cash handler logic).
  await applyVillaCreditAcrossSnapshots(tx, {
    societyId: billingCycle.societyId,
    villaId: user.villaId,
    financialYearId: billingCycle.financialYearId,
    throughCycleId: maintenanceCycle.id,
  });
}
