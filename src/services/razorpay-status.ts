/**
 * Normalizes Razorpay order / payment API responses for billing reconciliation.
 */

import type {
  PhonePePaymentStatusLabel,
  PhonePeSettlementOutcome,
  PhonePeStatusResult,
} from "./phonepe-status";
import { buildPhonePeStatusPending, buildPhonePeStatusUnavailable } from "./phonepe-status";

export type RazorpaySettlementOutcome = PhonePeSettlementOutcome;
export type RazorpayPaymentStatusLabel = PhonePePaymentStatusLabel;
export type RazorpayStatusResult = PhonePeStatusResult;

export const RAZORPAY_ORDER_PAID = "paid";
export const RAZORPAY_ORDER_PENDING = new Set(["created", "attempted"]);
export const RAZORPAY_PAYMENT_CAPTURED = new Set(["captured"]);
export const RAZORPAY_PAYMENT_FAILED = new Set(["failed"]);

/** Webhook events that should settle maintenance (not merely authorize). */
export const RAZORPAY_SETTLE_EVENTS = new Set(["payment.captured"]);
export const RAZORPAY_FAIL_EVENTS = new Set(["payment.failed"]);

export function isRazorpayWebhookSettleEvent(eventName: string): boolean {
  return RAZORPAY_SETTLE_EVENTS.has(eventName);
}

export function isRazorpayWebhookFailEvent(eventName: string): boolean {
  return RAZORPAY_FAIL_EVENTS.has(eventName);
}

export function classifyRazorpayOrderAndPayments(params: {
  orderStatus?: string;
  payments?: Array<{ status?: string; id?: string }>;
}): Pick<
  RazorpayStatusResult,
  | "outcome"
  | "paymentStatus"
  | "rawState"
  | "rawCode"
  | "gatewaySuccessFlag"
  | "gatewayTransactionId"
> {
  const orderStatus = (params.orderStatus ?? "unknown").toLowerCase();
  const payments = params.payments ?? [];

  const captured = payments.filter((p) =>
    RAZORPAY_PAYMENT_CAPTURED.has((p.status ?? "").toLowerCase()),
  );
  const failed = payments.filter((p) =>
    RAZORPAY_PAYMENT_FAILED.has((p.status ?? "").toLowerCase()),
  );

  if (orderStatus === RAZORPAY_ORDER_PAID || captured.length > 0) {
    return {
      outcome: "completed",
      paymentStatus: "SUCCESS",
      rawState: orderStatus,
      rawCode: captured[0]?.status ?? "captured",
      gatewaySuccessFlag: true,
      gatewayTransactionId: captured[0]?.id,
    };
  }

  if (failed.length > 0 && captured.length === 0) {
    return {
      outcome: "failed",
      paymentStatus: "FAILED",
      rawState: orderStatus,
      rawCode: failed[0]?.status ?? "failed",
      gatewaySuccessFlag: false,
    };
  }

  if (RAZORPAY_ORDER_PENDING.has(orderStatus) || payments.length === 0) {
    return {
      outcome: "pending",
      paymentStatus: "PENDING",
      rawState: orderStatus,
      rawCode: payments[0]?.status,
      gatewaySuccessFlag: false,
    };
  }

  return {
    outcome: "unknown",
    paymentStatus: "UNKNOWN",
    rawState: orderStatus,
    rawCode: payments[0]?.status,
    gatewaySuccessFlag: false,
  };
}

export function mergeRazorpayStatusWithLocal(
  gateway: RazorpayStatusResult,
  localStatus: "SUCCESS" | "PENDING" | "FAILED" | null | undefined,
): RazorpayStatusResult {
  if (localStatus === "SUCCESS") {
    return {
      ...gateway,
      outcome: "recorded",
      paymentStatus: "SUCCESS",
      detail: gateway.detail ?? "Payment already recorded on server",
    };
  }
  if (localStatus === "FAILED" && gateway.outcome === "pending") {
    return {
      ...gateway,
      outcome: "failed",
      paymentStatus: "FAILED",
      detail: gateway.detail ?? "Payment marked failed locally",
    };
  }
  return gateway;
}

export { buildPhonePeStatusPending as buildRazorpayStatusPending };
export { buildPhonePeStatusUnavailable as buildRazorpayStatusUnavailable };
