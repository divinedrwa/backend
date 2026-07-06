import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildApprovedVehicleSearchWhere,
  registrationDigitsOnly,
} from "./vehicleRegistration";

describe("vehicleRegistration", () => {
  it("extracts digits for partial plate search", () => {
    assert.equal(registrationDigitsOnly("KA01 AB 5670"), "015670");
    assert.equal(registrationDigitsOnly("5670"), "5670");
  });

  it("5670 matches plate KA01 AB 5670 via digits contains", () => {
    const stored = registrationDigitsOnly("KA01 AB 5670");
    assert.ok(stored.includes("5670"));
  });

  it("builds numeric contains filter when query is digits only", () => {
    const where = buildApprovedVehicleSearchWhere("soc1", "5670");
    assert.equal(where.societyId, "soc1");
    assert.equal(where.status, "APPROVED");
    const and = where.AND as { OR: unknown[] }[];
    assert.ok(Array.isArray(and));
    const or = and[0]?.OR as { registrationDigits?: { contains: string } }[];
    assert.ok(or.some((clause) => clause.registrationDigits?.contains === "5670"));
  });

  it("filters by vehicle type when provided", () => {
    const where = buildApprovedVehicleSearchWhere(
      "soc1",
      undefined,
      undefined,
      "TWO_WHEELER",
    );
    assert.equal(where.type, "TWO_WHEELER");
  });
});
