import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MaintenanceBillingMode, Prisma } from "@prisma/client";
import {
  computeExpectedForVilla,
  maintenanceCycleRuleFromConfig,
  parseSocietyBillingConfig,
  representativeBillingCycleAmount,
} from "./maintenanceAmount.js";

describe("maintenanceAmount", () => {
  it("FIXED mode uses society fixed amount for every villa", () => {
    const config = parseSocietyBillingConfig(
      {
        maintenanceBillingMode: MaintenanceBillingMode.FIXED,
        maintenanceFixedAmount: new Prisma.Decimal(1100),
        maintenanceSqftRate: null,
      },
      0,
    );
    const rule = maintenanceCycleRuleFromConfig(config);
    const villa = {
      id: "v1",
      area: new Prisma.Decimal(1200),
      monthlyMaintenance: new Prisma.Decimal(500),
    };
    const { expected } = computeExpectedForVilla({ ...rule, customAmounts: null }, villa);
    assert.equal(expected, 1100);
  });

  it("SQFT mode multiplies area by rate", () => {
    const config = parseSocietyBillingConfig(
      {
        maintenanceBillingMode: MaintenanceBillingMode.SQFT,
        maintenanceFixedAmount: null,
        maintenanceSqftRate: new Prisma.Decimal(1.1),
      },
      0,
    );
    const rule = maintenanceCycleRuleFromConfig(config);
    const villa = {
      id: "v1",
      area: new Prisma.Decimal(1000),
      monthlyMaintenance: new Prisma.Decimal(1100),
    };
    const { expected, breakdown } = computeExpectedForVilla({ ...rule, customAmounts: null }, villa);
    assert.equal(expected, 1100);
    assert.equal((breakdown as { perSqftRate: number }).perSqftRate, 1.1);
  });

  it("SQFT falls back to villa monthlyMaintenance when area missing", () => {
    const config = parseSocietyBillingConfig(
      {
        maintenanceBillingMode: MaintenanceBillingMode.SQFT,
        maintenanceFixedAmount: null,
        maintenanceSqftRate: new Prisma.Decimal(2),
      },
      0,
    );
    const rule = maintenanceCycleRuleFromConfig(config);
    const villa = {
      id: "v1",
      area: null,
      monthlyMaintenance: new Prisma.Decimal(1100),
    };
    const { expected } = computeExpectedForVilla({ ...rule, customAmounts: null }, villa);
    assert.equal(expected, 1100);
  });

  it("representativeBillingCycleAmount averages SQFT villas", () => {
    const config = parseSocietyBillingConfig(
      {
        maintenanceBillingMode: MaintenanceBillingMode.SQFT,
        maintenanceFixedAmount: null,
        maintenanceSqftRate: new Prisma.Decimal(1),
      },
      0,
    );
    const avg = representativeBillingCycleAmount(config, [
      { id: "a", area: new Prisma.Decimal(1000), monthlyMaintenance: new Prisma.Decimal(0) },
      { id: "b", area: new Prisma.Decimal(1200), monthlyMaintenance: new Prisma.Decimal(0) },
    ]);
    assert.equal(avg, 1100);
  });
});
