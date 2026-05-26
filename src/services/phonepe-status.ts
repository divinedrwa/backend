/**
 * Normalizes PhonePe status API / S2S callback payloads into a small set of outcomes
 * the billing layer and mobile client can act on — never rely on raw null from fetch.
 */

export const PHONEPE_COMPLETED_STATES = new Set([
  "COMPLETED",
  "PAYMENT_SUCCESS",
  "SUCCESS", // payResponseCode / legacy aliases
]);

export const PHONEPE_FAILED_STATES = new Set([
  "FAILED",
  "PAYMENT_ERROR",
  "PAYMENT_DECLINED",
  "DECLINED",
  "TIMED_OUT",
  "CANCELLED",
  "VOID",
  "EXPIRED",
]);

export const PHONEPE_PENDING_STATES = new Set([
  "PENDING",
  "INITIATED",
  "PAYMENT_PENDING",
  "PAYMENT_INITIATED",
  "NOT_FOUND",
]);

/** Client + server semantic beyond raw PhonePe state strings. */
export type PhonePeSettlementOutcome =
  | "recorded"
  | "completed"
  | "pending"
  | "failed"
  | "gateway_unavailable"
  | "unknown";

export type PhonePePaymentStatusLabel = "SUCCESS" | "PENDING" | "FAILED" | "UNKNOWN";

export type PhonePeStatusResult = {
  outcome: PhonePeSettlementOutcome;
  paymentStatus: PhonePePaymentStatusLabel;
  rawState: string;
  rawCode?: string;
  gatewayReachable: boolean;
  gatewaySuccessFlag: boolean;
  amountPaise?: number;
  httpStatus?: number;
  detail?: string;
  /** Gateway payment id when known (e.g. Razorpay pay_xxx). */
  gatewayTransactionId?: string;
};

export function isPhonePePaymentSuccessful(
  _successFlag: boolean,
  state: string,
  code?: string,
): boolean {
  const s = state.toUpperCase();
  const c = code?.toUpperCase();
  if (PHONEPE_COMPLETED_STATES.has(s)) return true;
  if (c && PHONEPE_COMPLETED_STATES.has(c)) return true;
  return false;
}

export function isPhonePePaymentFailed(state: string, code?: string): boolean {
  const s = state.toUpperCase();
  const c = code?.toUpperCase();
  if (PHONEPE_FAILED_STATES.has(s)) return true;
  if (c && PHONEPE_FAILED_STATES.has(c)) return true;
  return false;
}

export function isPhonePePaymentPending(state: string, code?: string): boolean {
  const s = state.toUpperCase();
  const c = code?.toUpperCase();
  if (PHONEPE_PENDING_STATES.has(s)) return true;
  if (c && PHONEPE_PENDING_STATES.has(c)) return true;
  if (s === "UNKNOWN" && !c) return true;
  return false;
}

type ParsedPhonePeBody = {
  success?: boolean;
  code?: string;
  message?: string;
  data?: {
    state?: string;
    /** v1 status API often uses paymentState instead of state */
    paymentState?: string;
    amount?: number;
    responseCode?: string;
    payResponseCode?: string;
  };
};

/**
 * Classify a parsed PhonePe JSON body (status API or decoded callback).
 */
export function classifyPhonePeGatewayPayload(
  body: ParsedPhonePeBody,
): Pick<
  PhonePeStatusResult,
  "outcome" | "paymentStatus" | "rawState" | "rawCode" | "gatewaySuccessFlag" | "amountPaise"
> {
  const rawState =
    body.data?.state ??
    body.data?.paymentState ??
    body.data?.payResponseCode ??
    body.data?.responseCode ??
    body.code ??
    "UNKNOWN";
  const rawCode = body.code ?? body.data?.payResponseCode;
  const gatewaySuccessFlag = body.success === true;
  const state = rawState.toUpperCase();
  const code = rawCode?.toUpperCase();

  if (isPhonePePaymentSuccessful(gatewaySuccessFlag, state, code)) {
    return {
      outcome: "completed",
      paymentStatus: "SUCCESS",
      rawState,
      rawCode,
      gatewaySuccessFlag,
      amountPaise: body.data?.amount,
    };
  }

  if (isPhonePePaymentFailed(state, code)) {
    return {
      outcome: "failed",
      paymentStatus: "FAILED",
      rawState,
      rawCode,
      gatewaySuccessFlag,
      amountPaise: body.data?.amount,
    };
  }

  if (isPhonePePaymentPending(state, code)) {
    return {
      outcome: "pending",
      paymentStatus: "PENDING",
      rawState,
      rawCode,
      gatewaySuccessFlag,
      amountPaise: body.data?.amount,
    };
  }

  return {
    outcome: "unknown",
    paymentStatus: "UNKNOWN",
    rawState,
    rawCode,
    gatewaySuccessFlag,
    amountPaise: body.data?.amount,
  };
}

export function buildPhonePeStatusUnavailable(detail: string): PhonePeStatusResult {
  return {
    outcome: "gateway_unavailable",
    paymentStatus: "UNKNOWN",
    rawState: "UNAVAILABLE",
    gatewayReachable: false,
    gatewaySuccessFlag: false,
    detail,
  };
}

export function buildPhonePeStatusPending(
  detail: string,
  httpStatus?: number,
): PhonePeStatusResult {
  return {
    outcome: "pending",
    paymentStatus: "PENDING",
    rawState: "PENDING",
    gatewayReachable: true,
    gatewaySuccessFlag: false,
    httpStatus,
    detail,
  };
}

export function mergePhonePeStatusWithLocal(
  gateway: PhonePeStatusResult,
  localStatus: "SUCCESS" | "PENDING" | "FAILED" | null | undefined,
): PhonePeStatusResult {
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
