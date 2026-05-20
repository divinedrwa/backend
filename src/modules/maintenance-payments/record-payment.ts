import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  PaymentMode,
  Prisma,
  UserRole,
} from "@prisma/client";
import { clearExcludedResidentsUserCyclePayments } from "../../lib/maintenanceBillingRole";
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

  // 2. Check for existing payment
  const existingPayment = await tx.maintenancePayment.findFirst({
    where: { societyId, villaId, month, year },
    orderBy: { paymentDate: "desc" },
    select: { id: true, receiptNumber: true },
  });

  // Generate unique receipt number
  const receiptNumber = existingPayment?.receiptNumber
    ? existingPayment.receiptNumber
    : `RCP${year}${String(month).padStart(2, "0")}${Date.now().toString().slice(-6)}`;

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

  // 4. Create or update payment
  const payment = existingPayment
    ? await tx.maintenancePayment.update({
        where: { id: existingPayment.id },
        data: {
          maintenanceId: maintenance.id,
          amount,
          paymentDate: new Date(paymentDate),
          paymentMode: paymentMode as PaymentMode,
          transactionId,
          bankAccountId,
          remarks,
          maintenanceCollectionCycleId: mcc?.id ?? undefined,
          villaMaintenanceSnapshotId: snapshot?.id ?? undefined,
        },
        include: {
          villa: { select: { villaNumber: true, ownerName: true } },
          bankAccount: { select: { bankName: true, accountNumber: true } },
        },
      })
    : await tx.maintenancePayment.create({
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
        include: {
          villa: { select: { villaNumber: true, ownerName: true } },
          bankAccount: { select: { bankName: true, accountNumber: true } },
        },
      });

  // 5. Run credit walker to reconcile snapshot from MP ledger
  if (mcc) {
    await applyVillaCreditAcrossSnapshots(tx, {
      societyId,
      villaId,
      financialYearId: mcc.financialYearId,
      throughCycleId: mcc.id,
    });

    // 6. Sync UserCyclePayment so resident billing screens reflect the new payment
    const billingCycle = await tx.billingCycle.findFirst({
      where: { societyId, financialYearId: mcc.financialYearId, cycleKey: mcc.periodKey },
      select: { id: true },
    });
    if (billingCycle) {
      await clearExcludedResidentsUserCyclePayments(tx, {
        societyId,
        villaId,
        billingCycleId: billingCycle.id,
      });

      const reconciledSnap = await tx.villaMaintenanceSnapshot.findUnique({
        where: { cycleId_villaId: { cycleId: mcc.id, villaId } },
        select: { paidAmount: true, status: true },
      });
      const snapStatus = reconciledSnap?.status ?? "PENDING";
      const paidAmt = Number(reconciledSnap?.paidAmount ?? 0);

      const primaryResidents = await tx.user.findMany({
        where: {
          societyId,
          villaId,
          role: UserRole.RESIDENT,
          isActive: true,
          maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
        },
        select: { id: true },
      });
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
            source: BillingPaymentSource.CASH_MANUAL,
            manualMarkedByAdminId: recordedByUserId,
            paidAt: new Date(paymentDate),
          },
          update: {
            amountPaid: new Prisma.Decimal(paidAmt),
            paymentStatus: payStatus,
            source: BillingPaymentSource.CASH_MANUAL,
            manualMarkedByAdminId: recordedByUserId,
            paidAt: new Date(paymentDate),
          },
        });
      }
    }
  }

  // 7. Create audit log
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

  return { maintenance, payment };
}
