import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monthYearWithinFinancialYear } from "./maintenanceStatementPdf.js";

describe("maintenanceStatementPdf", () => {
  it("monthYearWithinFinancialYear respects FY bounds", () => {
    const start = new Date("2025-04-01T00:00:00.000Z");
    const end = new Date("2026-03-31T00:00:00.000Z");
    assert.equal(monthYearWithinFinancialYear(4, 2025, start, end), true);
    assert.equal(monthYearWithinFinancialYear(3, 2026, start, end), true);
    assert.equal(monthYearWithinFinancialYear(3, 2025, start, end), false);
    assert.equal(monthYearWithinFinancialYear(4, 2026, start, end), false);
  });
});
