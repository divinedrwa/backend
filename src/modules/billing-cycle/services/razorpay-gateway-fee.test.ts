import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRazorpayCheckoutBreakup } from "./razorpay-gateway-fee";

describe("computeRazorpayCheckoutBreakup", () => {
  it("adds platform fee and GST on top of maintenance due", () => {
    const breakup = computeRazorpayCheckoutBreakup(1000, {
      feePercent: 2,
      feeGstPercent: 18,
      feeFixedRupees: 0,
    });

    assert.equal(breakup.maintenanceAmount, 1000);
    assert.equal(breakup.platformFee, 20);
    assert.equal(breakup.platformFeeGst, 3.6);
    assert.equal(breakup.totalPayable, 1023.6);
    assert.equal(breakup.maintenanceAmountPaise, 100000);
    assert.equal(breakup.totalPayablePaise, 102360);
  });

  it("returns maintenance-only when fee percent is zero", () => {
    const breakup = computeRazorpayCheckoutBreakup(500, {
      feePercent: 0,
      feeGstPercent: 18,
      feeFixedRupees: 0,
    });

    assert.equal(breakup.totalPayable, 500);
    assert.equal(breakup.platformFee, 0);
  });
});
