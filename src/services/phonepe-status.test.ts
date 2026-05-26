import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyPhonePeGatewayPayload,
  isPhonePePaymentFailed,
  isPhonePePaymentSuccessful,
  mergePhonePeStatusWithLocal,
} from "./phonepe-status.js";

describe("classifyPhonePeGatewayPayload", () => {
  it("maps PAYMENT_SUCCESS to completed", () => {
    const r = classifyPhonePeGatewayPayload({
      success: true,
      code: "PAYMENT_SUCCESS",
      data: { state: "COMPLETED", amount: 10000 },
    });
    assert.equal(r.outcome, "completed");
    assert.equal(r.paymentStatus, "SUCCESS");
  });

  it("maps FAILED to failed", () => {
    const r = classifyPhonePeGatewayPayload({
      success: false,
      code: "PAYMENT_ERROR",
      data: { state: "FAILED" },
    });
    assert.equal(r.outcome, "failed");
    assert.equal(r.paymentStatus, "FAILED");
  });

  it("maps PENDING to pending", () => {
    const r = classifyPhonePeGatewayPayload({
      success: false,
      code: "PAYMENT_PENDING",
      data: { state: "PENDING" },
    });
    assert.equal(r.outcome, "pending");
    assert.equal(r.paymentStatus, "PENDING");
  });

  it("maps v1 paymentState COMPLETED with PAYMENT_SUCCESS code", () => {
    const r = classifyPhonePeGatewayPayload({
      success: true,
      code: "PAYMENT_SUCCESS",
      data: {
        paymentState: "COMPLETED",
        payResponseCode: "SUCCESS",
        amount: 50000,
      },
    });
    assert.equal(r.outcome, "completed");
    assert.equal(r.paymentStatus, "SUCCESS");
  });
});

describe("mergePhonePeStatusWithLocal", () => {
  it("returns recorded when local is SUCCESS", () => {
    const merged = mergePhonePeStatusWithLocal(
      {
        ...classifyPhonePeGatewayPayload({ success: false, code: "PENDING" }),
        gatewayReachable: true,
      },
      "SUCCESS",
    );
    assert.equal(merged.outcome, "recorded");
    assert.equal(merged.paymentStatus, "SUCCESS");
  });
});

describe("isPhonePePaymentSuccessful / isPhonePePaymentFailed", () => {
  it("detects success and failure", () => {
    assert.equal(isPhonePePaymentSuccessful(true, "PAYMENT_SUCCESS"), true);
    assert.equal(isPhonePePaymentFailed("FAILED"), true);
    assert.equal(isPhonePePaymentFailed("PENDING"), false);
  });
});
