import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChargeHeadAmountType, Prisma } from "@prisma/client";
import {
  computeChargeHeadBreakdown,
  computeChargeHeadLineAmount,
} from "./chargeHeads.js";
import {
  computeExpectedForVilla,
  maintenanceCycleRuleFromConfig,
  parseSocietyBillingConfig,
} from "./maintenanceAmount.js";

describe("chargeHeads", () => {
  it("FIXED head returns flat amount per villa", () => {
    const amount = computeChargeHeadLineAmount(
      {
        amountType: ChargeHeadAmountType.FIXED,
        fixedAmount: new Prisma.Decimal(500),
        perSqftRate: null,
      },
      1200,
    );
    assert.equal(amount, 500);
  });

  it("PER_SQFT head multiplies area by rate", () => {
    const amount = computeChargeHeadLineAmount(
      {
        amountType: ChargeHeadAmountType.PER_SQFT,
        fixedAmount: null,
        perSqftRate: new Prisma.Decimal(1.5),
      },
      1000,
    );
    assert.equal(amount, 1500);
  });

  it("sums multiple active heads when useChargeHeads is true", () => {
    const breakdown = computeChargeHeadBreakdown(
      [
        {
          id: "h1",
          code: "maintenance",
          label: "Maintenance",
          amountType: ChargeHeadAmountType.FIXED,
          fixedAmount: new Prisma.Decimal(1000),
          perSqftRate: null,
          sortOrder: 0,
          isActive: true,
        },
        {
          id: "h2",
          code: "sinking",
          label: "Sinking fund",
          amountType: ChargeHeadAmountType.FIXED,
          fixedAmount: new Prisma.Decimal(200),
          perSqftRate: null,
          sortOrder: 1,
          isActive: true,
        },
      ],
      1000,
      true,
    );
    assert.ok(breakdown);
    assert.equal(breakdown.totalAmount, 1200);
    assert.equal(breakdown.chargeLines.length, 2);
  });

  it("returns null when charge heads disabled", () => {
    const breakdown = computeChargeHeadBreakdown(
      [
        {
          id: "h1",
          code: "maintenance",
          label: "Maintenance",
          amountType: ChargeHeadAmountType.FIXED,
          fixedAmount: new Prisma.Decimal(1000),
          perSqftRate: null,
          sortOrder: 0,
          isActive: true,
        },
      ],
      1000,
      false,
    );
    assert.equal(breakdown, null);
  });
});

describe("A9 SQFT publish path", () => {
  it("SQFT society config produces per-villa expected from area × rate", () => {
    const config = parseSocietyBillingConfig(
      {
        maintenanceBillingMode: "SQFT",
        maintenanceFixedAmount: null,
        maintenanceSqftRate: new Prisma.Decimal(2),
      },
      1100,
    );
    const rule = maintenanceCycleRuleFromConfig(config);
    const villaA = {
      id: "a",
      area: new Prisma.Decimal(500),
      monthlyMaintenance: new Prisma.Decimal(1100),
    };
    const villaB = {
      id: "b",
      area: new Prisma.Decimal(800),
      monthlyMaintenance: new Prisma.Decimal(1100),
    };
    assert.equal(
      computeExpectedForVilla({ ...rule, customAmounts: null }, villaA).expected,
      1000,
    );
    assert.equal(
      computeExpectedForVilla({ ...rule, customAmounts: null }, villaB).expected,
      1600,
    );
  });
});
