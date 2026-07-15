import { PaymentMode } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";

export type GatewayRefundResult = {
  attempted: boolean;
  success: boolean;
  gatewayRefundId?: string;
  message: string;
};

const GATEWAY_MODES = new Set<PaymentMode>([PaymentMode.ONLINE, PaymentMode.PHONEPE]);

/**
 * Attempt a gateway refund for an online maintenance payment.
 * Sandbox societies skip the external call; production requires gateway credentials (L1).
 */
export async function attemptGatewayRefund(params: {
  societyId: string;
  transactionId: string | null | undefined;
  amount: number;
  paymentMode: PaymentMode;
}): Promise<GatewayRefundResult> {
  if (!GATEWAY_MODES.has(params.paymentMode)) {
    return {
      attempted: false,
      success: false,
      message: "NOT_GATEWAY_PAYMENT",
    };
  }

  if (!params.transactionId?.trim()) {
    return {
      attempted: false,
      success: false,
      message: "MISSING_GATEWAY_TRANSACTION_ID",
    };
  }

  const society = await prisma.society.findUnique({
    where: { id: params.societyId },
    select: { isSandbox: true },
  });

  if (society?.isSandbox) {
    logger.info(
      { societyId: params.societyId, transactionId: params.transactionId },
      "[GatewayRefund] Skipping external refund for sandbox society",
    );
    return {
      attempted: true,
      success: false,
      message: "SANDBOX_SKIP_GATEWAY_REFUND",
    };
  }

  // Production gateway refund APIs (Razorpay / PhonePe) are society-scoped credentials.
  // Ledger reversal proceeds regardless; admin must complete refund in gateway dashboard if this fails.
  logger.warn(
    { societyId: params.societyId, transactionId: params.transactionId, amount: params.amount },
    "[GatewayRefund] Gateway refund API not yet wired — ledger reversal only",
  );
  return {
    attempted: true,
    success: false,
    message: "GATEWAY_REFUND_NOT_CONFIGURED",
  };
}
