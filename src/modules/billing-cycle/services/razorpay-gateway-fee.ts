import { PaymentMethodType } from "@prisma/client";
import { prisma } from "../../../lib/prisma";

/** Config for Razorpay platform fee + GST on fee (charged on top of maintenance due). */
export type RazorpayGatewayFeeConfig = {
  /** Percent of maintenance due (e.g. 2 = 2%). */
  feePercent: number;
  /** GST percent applied to the platform fee (e.g. 18). */
  feeGstPercent: number;
  /** Optional fixed fee in rupees added before GST. */
  feeFixedRupees: number;
};

export type RazorpayCheckoutBreakup = {
  /** Society maintenance due — shown in app and credited to ledger. */
  maintenanceAmount: number;
  platformFee: number;
  platformFeeGst: number;
  /** Amount charged at Razorpay checkout (maintenance + fee + GST). */
  totalPayable: number;
  maintenanceAmountPaise: number;
  platformFeePaise: number;
  platformFeeGstPaise: number;
  totalPayablePaise: number;
};

function parseNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function roundMoney(rupees: number): number {
  return Math.round(rupees * 100) / 100;
}

function toPaise(rupees: number): number {
  return Math.max(0, Math.round(rupees * 100));
}

/** Global fee config from environment (Render / local .env). */
export function getEnvRazorpayGatewayFeeConfig(): RazorpayGatewayFeeConfig {
  return {
    feePercent: parseNonNegativeNumber(process.env.RAZORPAY_PLATFORM_FEE_PERCENT, 0),
    feeGstPercent: parseNonNegativeNumber(process.env.RAZORPAY_PLATFORM_FEE_GST_PERCENT, 18),
    feeFixedRupees: parseNonNegativeNumber(process.env.RAZORPAY_PLATFORM_FEE_FIXED, 0),
  };
}

/** Per-society overrides from PaymentMethod.config when set. */
export async function getRazorpayGatewayFeeConfigForSociety(
  societyId: string,
): Promise<RazorpayGatewayFeeConfig> {
  const base = getEnvRazorpayGatewayFeeConfig();

  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.RAZORPAY,
      isEnabled: true,
    },
    select: { config: true },
  });

  if (!method) return base;

  const config = method.config as Record<string, unknown>;
  const feePercent =
    config.feePercent !== undefined
      ? parseNonNegativeNumber(String(config.feePercent), base.feePercent)
      : base.feePercent;
  const feeGstPercent =
    config.feeGstPercent !== undefined
      ? parseNonNegativeNumber(String(config.feeGstPercent), base.feeGstPercent)
      : base.feeGstPercent;
  const feeFixedRupees =
    config.feeFixedRupees !== undefined
      ? parseNonNegativeNumber(String(config.feeFixedRupees), base.feeFixedRupees)
      : base.feeFixedRupees;

  return { feePercent, feeGstPercent, feeFixedRupees };
}

/**
 * Compute checkout totals: maintenance due stays separate; customer pays maintenance + fee + GST.
 */
export function computeRazorpayCheckoutBreakup(
  maintenanceAmountRupees: number,
  feeConfig: RazorpayGatewayFeeConfig,
): RazorpayCheckoutBreakup {
  const maintenanceAmount = roundMoney(Math.max(0, maintenanceAmountRupees));
  const percentFee = roundMoney((maintenanceAmount * feeConfig.feePercent) / 100);
  const platformFee = roundMoney(percentFee + feeConfig.feeFixedRupees);
  const platformFeeGst = roundMoney((platformFee * feeConfig.feeGstPercent) / 100);
  const totalPayable = roundMoney(maintenanceAmount + platformFee + platformFeeGst);

  return {
    maintenanceAmount,
    platformFee,
    platformFeeGst,
    totalPayable,
    maintenanceAmountPaise: toPaise(maintenanceAmount),
    platformFeePaise: toPaise(platformFee),
    platformFeeGstPaise: toPaise(platformFeeGst),
    totalPayablePaise: Math.max(100, toPaise(totalPayable)),
  };
}
