import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGatewayCheckoutQuote } from "./gateway-pay-all";

describe("buildGatewayCheckoutQuote", () => {
  it("charges cash due minus advance credit (1100 due, 100 credit → 1000)", () => {
    const result = buildGatewayCheckoutQuote(1100, 100);
    assert.equal(result.maintenanceAmount, 1000);
    assert.equal(result.creditApplied, 100);
  });

  it("auto-settles when credit covers full due", () => {
    const result = buildGatewayCheckoutQuote(100, 100);
    assert.equal(result.maintenanceAmount, 0);
    assert.equal(result.creditApplied, 100);
  });

  it("does not apply more credit than gross due", () => {
    const result = buildGatewayCheckoutQuote(500, 800);
    assert.equal(result.maintenanceAmount, 0);
    assert.equal(result.creditApplied, 500);
  });

  it("clamps negative inputs to zero", () => {
    const result = buildGatewayCheckoutQuote(-50, -10);
    assert.equal(result.creditApplied, 0);
    assert.equal(result.maintenanceAmount, 0);
  });

  it("conserves the gross due: credit + cash === grossDue when credit ≤ due", () => {
    const result = buildGatewayCheckoutQuote(1234.56, 234.56);
    assert.equal(
      Math.round((result.creditApplied + result.maintenanceAmount) * 100) / 100,
      1234.56,
    );
  });
});
