import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyRazorpayOrderAndPayments,
  isRazorpayWebhookFailEvent,
  isRazorpayWebhookSettleEvent,
  mergeRazorpayStatusWithLocal,
} from "./razorpay-status.js";

describe("classifyRazorpayOrderAndPayments", () => {
  it("maps paid order to completed", () => {
    const r = classifyRazorpayOrderAndPayments({ orderStatus: "paid", payments: [] });
    assert.equal(r.outcome, "completed");
    assert.equal(r.paymentStatus, "SUCCESS");
  });

  it("maps captured payment to completed", () => {
    const r = classifyRazorpayOrderAndPayments({
      orderStatus: "attempted",
      payments: [{ id: "pay_1", status: "captured" }],
    });
    assert.equal(r.outcome, "completed");
    assert.equal(r.gatewayTransactionId, "pay_1");
  });

  it("maps failed payment to failed", () => {
    const r = classifyRazorpayOrderAndPayments({
      orderStatus: "attempted",
      payments: [{ status: "failed" }],
    });
    assert.equal(r.outcome, "failed");
    assert.equal(r.paymentStatus, "FAILED");
  });

  it("maps created order to pending", () => {
    const r = classifyRazorpayOrderAndPayments({ orderStatus: "created", payments: [] });
    assert.equal(r.outcome, "pending");
    assert.equal(r.paymentStatus, "PENDING");
  });
});

describe("mergeRazorpayStatusWithLocal", () => {
  it("returns recorded when local SUCCESS", () => {
    const merged = mergeRazorpayStatusWithLocal(
      {
        outcome: "pending",
        paymentStatus: "PENDING",
        rawState: "created",
        gatewayReachable: true,
        gatewaySuccessFlag: false,
      },
      "SUCCESS",
    );
    assert.equal(merged.outcome, "recorded");
  });
});

describe("Razorpay webhook events", () => {
  it("settles only on payment.captured", () => {
    assert.equal(isRazorpayWebhookSettleEvent("payment.captured"), true);
    assert.equal(isRazorpayWebhookSettleEvent("payment.authorized"), false);
    assert.equal(isRazorpayWebhookFailEvent("payment.failed"), true);
  });
});
