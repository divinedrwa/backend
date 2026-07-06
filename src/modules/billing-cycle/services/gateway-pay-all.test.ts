import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Mirrors buildGatewayCheckoutQuote — keep in sync with gateway-pay-all.ts */
function quote(grossDue: number, availableCredit: number) {
  const creditApplied = Math.min(Math.max(0, availableCredit), Math.max(0, grossDue));
  const maintenanceAmount = Math.max(0, grossDue - creditApplied);
  return { grossDue, availableCredit, creditApplied, maintenanceAmount };
}

describe("gateway checkout credit adjustment", () => {
  it("charges cash due minus advance credit (1100 due, 100 credit → 1000)", () => {
    const result = quote(1100, 100);
    assert.equal(result.maintenanceAmount, 1000);
    assert.equal(result.creditApplied, 100);
  });

  it("auto-settles when credit covers full due", () => {
    const result = quote(100, 100);
    assert.equal(result.maintenanceAmount, 0);
    assert.equal(result.creditApplied, 100);
  });

  it("does not apply more credit than gross due", () => {
    const result = quote(500, 800);
    assert.equal(result.maintenanceAmount, 0);
    assert.equal(result.creditApplied, 500);
  });
});
