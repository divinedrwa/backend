import { MaintenanceBillingMode, MaintenanceCycleRuleType, Prisma } from "@prisma/client";

export type VillaAmountInput = {
  id: string;
  area: Prisma.Decimal | null;
  monthlyMaintenance: Prisma.Decimal;
};

export type CycleRuleInput = {
  ruleType: MaintenanceCycleRuleType;
  baseAmount: Prisma.Decimal | null;
  perSqftRate: Prisma.Decimal | null;
  customAmounts: Prisma.JsonValue | null;
};

export type SocietyBillingConfig = {
  mode: MaintenanceBillingMode;
  fixedAmount: number;
  sqftRate: number;
};

/** Parse society billing settings with safe fallbacks for pre-migration rows. */
export function parseSocietyBillingConfig(
  society: {
    maintenanceBillingMode?: MaintenanceBillingMode | null;
    maintenanceFixedAmount?: Prisma.Decimal | null;
    maintenanceSqftRate?: Prisma.Decimal | null;
  } | null | undefined,
  cycleAmountFallback = 0,
): SocietyBillingConfig {
  const mode = society?.maintenanceBillingMode ?? MaintenanceBillingMode.FIXED;
  const fixedFromSociety =
    society?.maintenanceFixedAmount != null
      ? Number(society.maintenanceFixedAmount)
      : null;
  const fixedAmount =
    fixedFromSociety != null && fixedFromSociety > 0
      ? fixedFromSociety
      : cycleAmountFallback > 0
        ? cycleAmountFallback
        : 0;
  const sqftRate =
    society?.maintenanceSqftRate != null ? Number(society.maintenanceSqftRate) : 0;
  return { mode, fixedAmount, sqftRate };
}

export function maintenanceCycleRuleFromConfig(
  config: SocietyBillingConfig,
): Pick<CycleRuleInput, "ruleType" | "baseAmount" | "perSqftRate"> {
  if (config.mode === MaintenanceBillingMode.SQFT) {
    return {
      ruleType: MaintenanceCycleRuleType.PER_SQFT,
      baseAmount: null,
      perSqftRate: new Prisma.Decimal(config.sqftRate),
    };
  }
  return {
    ruleType: MaintenanceCycleRuleType.FIXED_PER_FLAT,
    baseAmount: new Prisma.Decimal(config.fixedAmount),
    perSqftRate: null,
  };
}

export function computeExpectedForVilla(
  rule: CycleRuleInput,
  villa: VillaAmountInput,
): { expected: number; breakdown: Record<string, unknown> } {
  switch (rule.ruleType) {
    case MaintenanceCycleRuleType.FIXED_PER_FLAT: {
      const n = Number(rule.baseAmount ?? 0);
      return { expected: n, breakdown: { ruleType: rule.ruleType, baseAmount: n } };
    }
    case MaintenanceCycleRuleType.PER_SQFT: {
      const rate = Number(rule.perSqftRate ?? 0);
      const area = villa.area != null ? Number(villa.area) : 0;
      if (area > 0) {
        const raw = rate * area;
        const expected = Math.round(raw * 100) / 100;
        return { expected, breakdown: { ruleType: rule.ruleType, perSqftRate: rate, area } };
      }
      const fallback = Number(villa.monthlyMaintenance);
      return {
        expected: fallback,
        breakdown: {
          ruleType: rule.ruleType,
          perSqftRate: rate,
          area: null,
          fallbackMonthlyMaintenance: fallback,
        },
      };
    }
    case MaintenanceCycleRuleType.CUSTOM: {
      const map = rule.customAmounts as Record<string, number> | null;
      const fromMap = map && typeof map === "object" ? map[villa.id] : undefined;
      const expected =
        fromMap != null && Number.isFinite(Number(fromMap))
          ? Number(fromMap)
          : Number(rule.baseAmount ?? villa.monthlyMaintenance);
      return {
        expected,
        breakdown: {
          ruleType: rule.ruleType,
          fromCustomMap: fromMap != null,
          baseAmount: Number(rule.baseAmount ?? 0),
        },
      };
    }
    default:
      return { expected: 0, breakdown: {} };
  }
}

/** Representative BillingCycle.amount for SQFT mode (average across villas with area). */
export function representativeBillingCycleAmount(
  config: SocietyBillingConfig,
  villas: VillaAmountInput[],
): number {
  if (config.mode === MaintenanceBillingMode.FIXED) {
    return config.fixedAmount;
  }
  const rule = maintenanceCycleRuleFromConfig(config);
  const amounts = villas
    .map((v) => computeExpectedForVilla({ ...rule, customAmounts: null }, v).expected)
    .filter((n) => n > 0);
  if (amounts.length === 0) return 0;
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  return Math.round(avg * 100) / 100;
}
