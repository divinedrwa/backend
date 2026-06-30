import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  PaymentMode,
  Prisma,
} from "@prisma/client";
import { clearExcludedResidentsUserCyclePayments } from "../../lib/maintenanceBillingRole";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import { ensureVillaLedgersAligned } from "../billing-cycle/billing-collection-link";
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
  const mcc = await tx.maintenanceCollectionCycle.findFirst({
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
    ? await tx.maintenancePayment.findUnique({
        where: { idempotencyKey },
        include: paymentInclude,
      })
    : null;

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

  // 5. Run credit walker to reconcile snapshot from MP ledger
  if (mcc) {
    await applyVillaCreditAcrossSnapshots(tx, {
      societyId,
      villaId,
      financialYearId: mcc.financialYearId,
      // When walkAllCycles is set (e.g. "Pay All" multi-month payments),
      // let the walker process every cycle so overpayment credit flows
      // forward to settle subsequent unpaid cycles.
      throughCycleId: params.walkAllCycles ? undefined : mcc.id,
    });

    // 6. Sync UserCyclePayment so resident billing screens reflect the new payment.
    //    When walkAllCycles is set, sync ALL cycles in the financial year
    //    (not just the payment's cycle) since the walker may have updated many.
    const cyclesToSync = params.walkAllCycles
      ? await tx.maintenanceCollectionCycle.findMany({
          where: { societyId, financialYearId: mcc.financialYearId },
          orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
          select: { id: true, periodKey: true },
        })
      : [{ id: mcc.id, periodKey: mcc.periodKey }];

    const primaryResidents = await tx.user.findMany({
      where: {
        societyId,
        villaId,
        ...residentLikeRoleFilter,
        isActive: true,
        maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
      },
      select: { id: true },
    });

    for (const cycleToSync of cyclesToSync) {
      const billingCycle = await tx.billingCycle.findFirst({
        where: { societyId, financialYearId: mcc.financialYearId, cycleKey: cycleToSync.periodKey },
        select: { id: true },
      });
      if (!billingCycle) continue;

      await clearExcludedResidentsUserCyclePayments(tx, {
        societyId,
        villaId,
        billingCycleId: billingCycle.id,
      });

      const reconciledSnap = await tx.villaMaintenanceSnapshot.findUnique({
        where: { cycleId_villaId: { cycleId: cycleToSync.id, villaId } },
        select: { paidAmount: true, status: true },
      });
      const snapStatus = reconciledSnap?.status ?? "PENDING";
      const paidAmt = Number(reconciledSnap?.paidAmount ?? 0);

      const payStatus =
        snapStatus === "PAID" || snapStatus === "WAIVED"
          ? BillingUserPaymentStatus.SUCCESS
          : BillingUserPaymentStatus.PENDING;
      for (const u of primaryResidents) {
        await tx.userCyclePayment.upsert({
          where: { userId_cycleId: { userId: u.id, cycleId: billingCycle.id } },
          create: {
            userId: u.id,
            cycleId: billingCycle.id,
            amountPaid: new Prisma.Decimal(paidAmt),
            paymentStatus: payStatus,
            source: billingSource,
            manualMarkedByAdminId:
              billingSource === BillingPaymentSource.CASH_MANUAL ? recordedByUserId : null,
            paidAt: new Date(paymentDate),
          },
          update: {
            amountPaid: new Prisma.Decimal(paidAmt),
            paymentStatus: payStatus,
            source: billingSource,
            manualMarkedByAdminId:
              billingSource === BillingPaymentSource.CASH_MANUAL ? recordedByUserId : null,
            paidAt: new Date(paymentDate),
          },
        });
      }
    }

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
