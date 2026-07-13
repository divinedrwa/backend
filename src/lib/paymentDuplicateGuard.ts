import { PaymentMode, Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** Default look-back for admin cash duplicate detection (hours). */
export const DUPLICATE_PAYMENT_WINDOW_HOURS = 24;

export type LikelyDuplicatePayment = {
  id: string;
  receiptNumber: string;
  paymentDate: Date;
  amount: Prisma.Decimal;
  paymentMode: PaymentMode;
};

/**
 * Detect a likely duplicate manual payment: same villa, period, amount, mode
 * within a short time window (A4).
 */
export async function findLikelyDuplicateMaintenancePayment(
  tx: Tx,
  params: {
    societyId: string;
    villaId: string;
    month: number;
    year: number;
    amount: number;
    paymentMode: PaymentMode | string;
    paymentDate: Date;
    windowHours?: number;
    excludePaymentId?: string;
  },
): Promise<LikelyDuplicatePayment | null> {
  const windowHours = params.windowHours ?? DUPLICATE_PAYMENT_WINDOW_HOURS;
  const since = new Date(params.paymentDate.getTime() - windowHours * 60 * 60 * 1000);

  const row = await tx.maintenancePayment.findFirst({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      month: params.month,
      year: params.year,
      paymentMode: params.paymentMode as PaymentMode,
      amount: params.amount,
      paymentDate: { gte: since, lte: params.paymentDate },
      reversedAt: null,
      reversalOfPaymentId: null,
      ...(params.excludePaymentId ? { id: { not: params.excludePaymentId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      receiptNumber: true,
      paymentDate: true,
      amount: true,
      paymentMode: true,
    },
  });

  return row;
}
