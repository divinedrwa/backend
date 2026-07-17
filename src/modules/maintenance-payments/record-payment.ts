import {
  BillingPaymentSource,
  PaymentMode,
  Prisma,
} from "@prisma/client";
import crypto from "node:crypto";
import { findLikelyDuplicateMaintenancePayment } from "../../lib/paymentDuplicateGuard";
import { ensureVillaLedgersAligned, syncVillaBillingCyclesFromSnapshots } from "../billing-cycle/billing-collection-link";
import { applyVillaCreditAcrossSnapshots } from "../maintenance-management/credit-walker";

type Tx = Prisma.TransactionClient;

export interface RecordPaymentParams {
  societyId: string;
  villaId: string;
  month: number;
  year: number;
  amount: number;
  paymentDate: string;
  paymentMode: string;
  transactionId?: string;
  bankAccountId?: string;
  remarks?: string;
  idempotencyKey?: string;
  /** userId of whoever is recording (admin or the verifying admin) */
  recordedByUserId: string;
  auditAction?: string;
  /**
   * When true, the credit walker processes ALL cycles in the financial year
   * (not just up to the payment's cycle). This allows overpayment credit to
   * flow forward and settle subsequent unpaid cycles — used for "Pay All"
   * multi-month UPI payments.
   */
  walkAllCycles?: boolean;
  /** Source stamped on synced UserCyclePayment rows (defaults to manual cash). */
  billingSource?: BillingPaymentSource;
  /** Limit credit walker to cycles up to this collection cycle (mark-paid partial path). */
  throughCycleId?: string;
  /** Pre-linked collection cycle (skips month/year lookup when set). */
  maintenanceCollectionCycleId?: string;
}

/**
 * Shared payment recording pipeline used by both:
 * - POST /maintenance/payments (admin cash recording)
 * - POST /upi-payments/:id/verify (admin verifying a UPI submission)
 *
 * Must be called inside a Prisma.$transaction callback.
 */
export async function recordPaymentAndSyncLedgers(
  tx: Tx,
  params: RecordPaymentParams,
) {
  const {
    societyId,
    villaId,
    month,
    year,
    amount,
    paymentDate,
    paymentMode,
    transactionId,
    bankAccountId,
    remarks,
    idempotencyKey,
    recordedByUserId,
    auditAction = "RECORD_PAYMENT",
    billingSource = BillingPaymentSource.CASH_MANUAL,
    throughCycleId,
    maintenanceCollectionCycleId: explicitCycleId,
  } = params;

  // 1. Find or create maintenance record
  let maintenance = await tx.maintenance.findFirst({
    where: { societyId, villaId, month, year },
  });

  if (!maintenance) {
    maintenance = await tx.maintenance.create({
      data: {
        societyId,
        villaId,
        month,
        year,
        amount,
        dueDate: new Date(year, month - 1, 5),
        status: "PAID",
      },
    });
  } else if (maintenance.status !== "PAID") {
    maintenance = await tx.maintenance.update({
      where: { id: maintenance.id },
      data: { status: "PAID" },
    });
  }

  // Always generate a new receipt number for each payment record.
  // Multiple payments for the same month (e.g. partial cash + UPI balance) are valid
  // and each must have its own receipt. The ledger walker aggregates them.
  const receiptNumber = `RCP${year}${String(month).padStart(2, "0")}${Date.now().toString().slice(-6)}`;

  // 3. Resolve matching MaintenanceCollectionCycle
  const mcc = explicitCycleId
    ? await tx.maintenanceCollectionCycle.findFirst({
        where: { id: explicitCycleId, societyId },
        select: { id: true, financialYearId: true, periodKey: true, dueDate: true },
      })
    : await tx.maintenanceCollectionCycle.findFirst({
        where: { societyId, periodMonth: month, periodYear: year },
        select: { id: true, financialYearId: true, periodKey: true, dueDate: true },
      });

  const snapshot = mcc
    ? await tx.villaMaintenanceSnapshot.findUnique({
        where: { cycleId_villaId: { cycleId: mcc.id, villaId } },
        select: { id: true },
      })
    : null;

  // 4. Create a new payment row (never overwrite an existing one).
  // Each payment — cash, UPI, Razorpay — is an independent ledger event.
  // Idempotency: when an idempotencyKey is supplied (e.g. gateway pay-all settle,
  // which can be replayed by webhook + poll + resume-recovery), reuse the existing
  // row instead of inserting a duplicate. The credit walker sums every
  // MaintenancePayment for the villa, so a duplicate would silently double-credit.
  const paymentInclude = {
    villa: { select: { villaNumber: true, ownerName: true } },
    bankAccount: { select: { bankName: true, accountNumber: true } },
  } as const;

  const existingByKey = idempotencyKey
    ? await tx.maintenancePayment.findFirst({
        where: { idempotencyKey, societyId },
        include: paymentInclude,
      })
    : null;

  if (!existingByKey) {
    const duplicate = await findLikelyDuplicateMaintenancePayment(tx, {
      societyId,
      villaId,
      month,
      year,
      amount,
      paymentMode: paymentMode as PaymentMode,
      paymentDate: new Date(paymentDate),
    });
    if (duplicate) {
      const err = new Error(
        `Duplicate payment suspected: receipt ${duplicate.receiptNumber} already recorded for this villa, period, amount and mode within ${24}h`,
      ) as Error & { code: string; duplicatePaymentId: string };
      err.code = "DUPLICATE_PAYMENT_SUSPECTED";
      err.duplicatePaymentId = duplicate.id;
      throw err;
    }
  }

  const payment =
    existingByKey ??
    (await tx.maintenancePayment.create({
      data: {
        societyId,
        villaId,
        maintenanceId: maintenance.id,
        month,
        year,
        amount,
        paymentDate: new Date(paymentDate),
        paymentMode: paymentMode as PaymentMode,
        transactionId,
        receiptNumber,
        bankAccountId,
        remarks,
        idempotencyKey,
        maintenanceCollectionCycleId: mcc?.id ?? null,
        villaMaintenanceSnapshotId: snapshot?.id ?? null,
      },
      include: paymentInclude,
    }));

  // 5. Run credit walker + sync billing across all FYs/cycles
  if (mcc) {
    await applyVillaCreditAcrossSnapshots(tx, {
      societyId,
      villaId,
      financialYearId: mcc.financialYearId,
      ...(throughCycleId ? { throughCycleId } : {}),
    });

    await syncVillaBillingCyclesFromSnapshots(tx, {
      societyId,
      villaId,
      source: billingSource,
    });

    const paymentMonthBillingCycle = await tx.billingCycle.findFirst({
      where: { societyId, financialYearId: mcc.financialYearId, cycleKey: mcc.periodKey },
      select: { id: true },
    });
    if (paymentMonthBillingCycle) {
      await ensureVillaLedgersAligned(tx, {
        societyId,
        villaId,
        billingCycleId: paymentMonthBillingCycle.id,
      });
    }
  }

  // 7. Audit log (gateway settlements skip — resident id is not an admin actor)
  if (billingSource !== BillingPaymentSource.GATEWAY) {
    await tx.adminAuditLog.create({
      data: {
        adminId: recordedByUserId,
        societyId,
        action: auditAction,
        entityType: "MaintenancePayment",
        entityId: payment.id,
        metadata: {
          villaId,
          month,
          year,
          amount: amount.toString(),
          paymentMode,
          transactionId,
          receiptNumber,
          timestamp: new Date().toISOString(),
        },
      },
    });
  }

  return { maintenance, payment };
}

export interface CreditMarkerParams {
  societyId: string;
  villaId: string;
  maintenanceId: string;
  month: number;
  year: number;
  maintenanceCollectionCycleId: string;
  villaMaintenanceSnapshotId: string;
  financialYearId: string;
  creditApplied: number;
  recordedByUserId: string;
}

/**
 * ₹0 audit marker when advance credit is applied to a cycle (A1 canonical credit path).
 */
export async function recordCreditMarkerPayment(
  tx: Tx,
  params: CreditMarkerParams,
): Promise<void> {
  const receiptNumber = `CRD-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  await tx.maintenancePayment.create({
    data: {
      societyId: params.societyId,
      villaId: params.villaId,
      maintenanceId: params.maintenanceId,
      month: params.month,
      year: params.year,
      amount: 0,
      paymentDate: new Date(),
      paymentMode: "CASH",
      receiptNumber,
      remarks: `Advance credit adjustment (₹${params.creditApplied} applied)`,
      maintenanceCollectionCycleId: params.maintenanceCollectionCycleId,
      villaMaintenanceSnapshotId: params.villaMaintenanceSnapshotId,
    },
  });

  await applyVillaCreditAcrossSnapshots(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    financialYearId: params.financialYearId,
  });

  await syncVillaBillingCyclesFromSnapshots(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    source: BillingPaymentSource.CASH_MANUAL,
  });

  await tx.adminAuditLog.create({
    data: {
      adminId: params.recordedByUserId,
      societyId: params.societyId,
      action: "CREDIT_MARKER",
      entityType: "MaintenancePayment",
      entityId: params.villaMaintenanceSnapshotId,
      metadata: {
        villaId: params.villaId,
        creditApplied: params.creditApplied.toString(),
        cycleId: params.maintenanceCollectionCycleId,
        timestamp: new Date().toISOString(),
      },
    },
  });
}
