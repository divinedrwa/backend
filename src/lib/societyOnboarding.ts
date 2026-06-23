import { BillingCycleStatus } from "@prisma/client";

export type SocietyOnboardingStatus =
  | "PROVISIONED"
  | "SETUP"
  | "LIVE"
  | "ARCHIVED";

type OnboardingInput = {
  archivedAt: Date | null;
  villaCount: number;
  billingCycleCount: number;
  openBillingCycleCount: number;
  gatewayPaymentCount: number;
};

export function computeOnboardingStatus(input: OnboardingInput): SocietyOnboardingStatus {
  if (input.archivedAt) return "ARCHIVED";
  if (input.villaCount === 0) return "PROVISIONED";
  if (input.billingCycleCount === 0) return "SETUP";
  if (input.openBillingCycleCount > 0 || input.gatewayPaymentCount > 0) return "LIVE";
  return "SETUP";
}

export function hasOpenBillingCycle(status: BillingCycleStatus): boolean {
  return status === BillingCycleStatus.OPEN;
}
