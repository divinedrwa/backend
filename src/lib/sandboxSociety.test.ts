import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaymentMethodType } from "@prisma/client";
import {
  isRazorpayLiveKeyId,
  isRazorpayTestKeyId,
  parsePhonePeEnvironment,
  validateGatewayConfigForSandbox,
  withProductionOnlyFilter,
} from "./sandboxSociety";

describe("sandboxSociety gateway config", () => {
  it("detects Razorpay test vs live key prefixes", () => {
    assert.equal(isRazorpayTestKeyId("rzp_test_abc"), true);
    assert.equal(isRazorpayLiveKeyId("rzp_live_xyz"), true);
    assert.equal(isRazorpayTestKeyId("rzp_live_xyz"), false);
    assert.equal(isRazorpayLiveKeyId("rzp_test_abc"), false);
  });

  it("parses PhonePe environment", () => {
    assert.equal(parsePhonePeEnvironment("production"), "PRODUCTION");
    assert.equal(parsePhonePeEnvironment("SANDBOX"), "SANDBOX");
    assert.equal(parsePhonePeEnvironment(undefined), "SANDBOX");
  });

  it("blocks live Razorpay on sandbox", () => {
    const issue = validateGatewayConfigForSandbox(PaymentMethodType.RAZORPAY, {
      keyId: "rzp_live_123",
    });
    assert.ok(issue);
    assert.equal(issue?.code, "SANDBOX_LIVE_GATEWAY_FORBIDDEN");
  });

  it("allows test Razorpay on sandbox", () => {
    const issue = validateGatewayConfigForSandbox(PaymentMethodType.RAZORPAY, {
      keyId: "rzp_test_123",
    });
    assert.equal(issue, null);
  });

  it("blocks PhonePe PRODUCTION on sandbox", () => {
    const issue = validateGatewayConfigForSandbox(PaymentMethodType.PHONEPE, {
      environment: "PRODUCTION",
    });
    assert.ok(issue);
  });

  it("allows UPI configs on sandbox", () => {
    const issue = validateGatewayConfigForSandbox(PaymentMethodType.UPI_VPA, {
      vpa: "society@upi",
    });
    assert.equal(issue, null);
  });
});

describe("productionSocietyWhere filter", () => {
  it("excludes sandbox when column exists", () => {
    const where = withProductionOnlyFilter({ status: "ACTIVE" }, true);
    assert.equal(where.isSandbox, false);
    assert.equal(where.status, "ACTIVE");
  });

  it("leaves filter unchanged when column missing", () => {
    const where = withProductionOnlyFilter({ status: "ACTIVE" }, false);
    assert.equal(where.isSandbox, undefined);
  });
});
