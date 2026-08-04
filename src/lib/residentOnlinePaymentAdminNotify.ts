import { NotificationCategory, PaymentMode, UserRole } from "@prisma/client";
import { prisma } from "./prisma";
import { notifySocietyRoles } from "../services/notification.service";

/** Society admins who should receive payment alerts (includes villa-allotted admin-residents). */
export const ADMIN_PAYMENT_NOTIFY_ROLES: UserRole[] = [
  UserRole.ADMIN,
  UserRole.RESIDENT_CUM_ADMIN,
];

export type ResidentOnlinePaymentAdminNotifyParams = {
  societyId: string;
  residentUserId: string;
  villaId: string;
  amount: number;
  cycleId: string;
  cycleKey?: string | null;
  paymentMode: PaymentMode;
  payAllPending?: boolean;
};

function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function paymentModeLabel(mode: PaymentMode): string {
  switch (mode) {
    case PaymentMode.ONLINE:
      return "Razorpay";
    case PaymentMode.PHONEPE:
      return "PhonePe";
    case PaymentMode.UPI:
      return "UPI";
    default:
      return "Online";
  }
}

function villaDisplayLabel(villa: { villaNumber: string; block: string | null } | null): string {
  if (!villa?.villaNumber) return "Villa";
  const num = villa.villaNumber.trim();
  const block = villa.block?.trim();
  if (block) return `Block ${block}, Villa ${num}`;
  return `Villa ${num}`;
}

/**
 * Notify all society admins when a resident completes an online gateway payment.
 * Fire-and-forget — callers should not await in a transaction.
 */
export async function notifyAdminsResidentOnlinePaymentSuccess(
  params: ResidentOnlinePaymentAdminNotifyParams,
): Promise<void> {
  try {
    const [resident, villa, cycle] = await Promise.all([
      prisma.user.findUnique({
        where: { id: params.residentUserId },
        select: { name: true },
      }),
      prisma.villa.findUnique({
        where: { id: params.villaId },
        select: { villaNumber: true, block: true },
      }),
      prisma.billingCycle.findUnique({
        where: { id: params.cycleId },
        select: { cycleKey: true, title: true },
      }),
    ]);

    const villaLabel = villaDisplayLabel(villa);
    const residentName = resident?.name?.trim() || "A resident";
    const amountStr = formatInr(params.amount);
    const modeLabel = paymentModeLabel(params.paymentMode);
    const cycleKey = (params.cycleKey ?? cycle?.cycleKey ?? "").trim();
    const cycleTitle = (cycle?.title ?? cycleKey).trim();

    const periodPart = params.payAllPending
      ? "all pending maintenance dues"
      : cycleTitle || cycleKey || "maintenance";

    const body = `${residentName} (${villaLabel}) paid ${amountStr} for ${periodPart} via ${modeLabel}.`;

    await notifySocietyRoles({
      societyId: params.societyId,
      roles: ADMIN_PAYMENT_NOTIFY_ROLES,
      category: NotificationCategory.PAYMENT,
      title: "Online maintenance payment received",
      body,
      data: {
        type: "RESIDENT_ONLINE_PAYMENT_RECEIVED",
        villaId: params.villaId,
        villaNumber: villa?.villaNumber ?? "",
        residentUserId: params.residentUserId,
        cycleId: params.cycleId,
        cycleKey,
        amount: String(params.amount),
        paymentMode: params.paymentMode,
        payAllPending: params.payAllPending ? "true" : "false",
      },
    });
  } catch {
    // Optional push — must not fail settlement
  }
}
