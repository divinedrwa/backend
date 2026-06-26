import { prisma } from "../../../lib/prisma";
import type { computeRazorpayCheckoutBreakup } from "./razorpay-gateway-fee";

/** Razorpay order notes: max 15 keys, 256 chars per value, 32 chars per key. */
export const RAZORPAY_NOTE_MAX_KEYS = 15;
export const RAZORPAY_NOTE_MAX_VALUE_LEN = 256;

export type GatewayPaymentResidentContext = {
  societyName: string;
  residentName: string;
  residentEmail: string;
  residentPhone: string;
  villaLabel: string;
};

export type RazorpayCheckoutBreakupNotes = Pick<
  ReturnType<typeof computeRazorpayCheckoutBreakup>,
  "maintenanceAmount" | "platformFee" | "platformFeeGst" | "totalPayable"
>;

/** Format INR amounts for Razorpay notes (rupees, not paise). */
export function formatInrAmountForNote(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return String(parseFloat(rounded.toFixed(2)));
}

/**
 * Read amounts from Razorpay order notes — prefers INR rupee keys, falls back to
 * legacy `*Paise` keys for orders created before the rupee note migration.
 */
export function parseRazorpayOrderNoteAmounts(
  notes?: Record<string, string> | null,
): {
  maintenanceAmount: number;
  platformFee: number;
  platformFeeGst: number;
  totalPayable: number;
  expectedPaise: number;
} {
  const readRupeesOrLegacyPaise = (rupeeKey: string, paiseKey: string): number => {
    if (notes && notes[rupeeKey] != null && String(notes[rupeeKey]).trim() !== "") {
      const rupees = Number(notes[rupeeKey]);
      return Number.isFinite(rupees) ? rupees : 0;
    }
    const paise = Number(notes?.[paiseKey] ?? 0);
    return Number.isFinite(paise) && paise > 0 ? paise / 100 : 0;
  };

  const maintenanceAmount = readRupeesOrLegacyPaise("maintenanceAmount", "maintenanceAmountPaise");
  const platformFee = readRupeesOrLegacyPaise("platformFee", "platformFeePaise");
  const platformFeeGst = readRupeesOrLegacyPaise("platformFeeGst", "platformFeeGstPaise");

  let totalPayable = 0;
  if (notes?.totalPayable != null && String(notes.totalPayable).trim() !== "") {
    const parsed = Number(notes.totalPayable);
    totalPayable = Number.isFinite(parsed) ? parsed : 0;
  } else if (maintenanceAmount > 0 || platformFee > 0 || platformFeeGst > 0) {
    totalPayable = maintenanceAmount + platformFee + platformFeeGst;
  }

  const expectedPaise =
    maintenanceAmount > 0 || platformFee > 0 || platformFeeGst > 0
      ? Math.round((maintenanceAmount + platformFee + platformFeeGst) * 100)
      : 0;

  return { maintenanceAmount, platformFee, platformFeeGst, totalPayable, expectedPaise };
}

export function truncateRazorpayNoteValue(value: string | number | null | undefined): string {
  const text = String(value ?? "").trim();
  if (text.length <= RAZORPAY_NOTE_MAX_VALUE_LEN) return text;
  return `${text.slice(0, RAZORPAY_NOTE_MAX_VALUE_LEN - 1)}…`;
}

export function formatVillaLabel(
  villa?: { villaNumber: string; block: string | null } | null,
): string {
  if (!villa?.villaNumber?.trim()) return "";
  const block = villa.block?.trim();
  return block ? `${block} - ${villa.villaNumber.trim()}` : villa.villaNumber.trim();
}

export async function loadGatewayPaymentResidentContext(
  societyId: string,
  userId: string,
): Promise<GatewayPaymentResidentContext> {
  const user = await prisma.user.findFirst({
    where: { id: userId, societyId },
    select: {
      name: true,
      email: true,
      phone: true,
      villa: { select: { villaNumber: true, block: true } },
      society: { select: { name: true } },
    },
  });

  return {
    societyName: user?.society?.name?.trim() ?? "",
    residentName: user?.name?.trim() ?? "",
    residentEmail: user?.email?.trim() ?? "",
    residentPhone: user?.phone?.trim() ?? "",
    villaLabel: formatVillaLabel(user?.villa),
  };
}

/**
 * Razorpay dashboard notes for maintenance checkout — IDs for automation plus
 * human-readable labels for society admins.
 */
export function buildRazorpayMaintenanceOrderNotes(params: {
  societyId: string;
  cycleId: string;
  userId: string;
  cycleKey: string;
  cycleTitle: string;
  breakup: RazorpayCheckoutBreakupNotes;
  resident: GatewayPaymentResidentContext;
  payAllPending?: boolean;
  pendingCycleCount?: number;
}): Record<string, string> {
  const notes: Record<string, string> = {
    societyId: params.societyId,
    societyName: truncateRazorpayNoteValue(params.resident.societyName),
    cycleId: params.cycleId,
    cycleKey: truncateRazorpayNoteValue(params.cycleKey),
    cycleTitle: truncateRazorpayNoteValue(params.cycleTitle),
    userId: params.userId,
    residentName: truncateRazorpayNoteValue(params.resident.residentName),
    residentEmail: truncateRazorpayNoteValue(params.resident.residentEmail),
    villaNo: truncateRazorpayNoteValue(params.resident.villaLabel),
    maintenanceAmount: formatInrAmountForNote(params.breakup.maintenanceAmount),
    platformFee: formatInrAmountForNote(params.breakup.platformFee),
    platformFeeGst: formatInrAmountForNote(params.breakup.platformFeeGst),
    totalPayable: formatInrAmountForNote(params.breakup.totalPayable),
  };

  if (params.resident.residentPhone) {
    notes.residentPhone = truncateRazorpayNoteValue(params.resident.residentPhone);
  }
  if (params.payAllPending) {
    notes.payAllPending = "true";
    if (params.pendingCycleCount != null && params.pendingCycleCount > 0) {
      notes.pendingCycleCount = String(params.pendingCycleCount);
    }
  }

  return trimRazorpayNotesToLimit(notes);
}

/** Drop lowest-priority optional fields if we exceed Razorpay's 15-key cap. */
function trimRazorpayNotesToLimit(notes: Record<string, string>): Record<string, string> {
  const keys = Object.keys(notes);
  if (keys.length <= RAZORPAY_NOTE_MAX_KEYS) return notes;

  const dropOrder = ["residentPhone", "pendingCycleCount", "payAllPending", "residentEmail"];
  const trimmed = { ...notes };
  for (const key of dropOrder) {
    if (Object.keys(trimmed).length <= RAZORPAY_NOTE_MAX_KEYS) break;
    delete trimmed[key];
  }
  return trimmed;
}

/** Internal billing log payload — same context admins see in Razorpay notes. */
export function buildGatewayCreateOrderLogPayload(params: {
  orderId: string;
  breakup: RazorpayCheckoutBreakupNotes;
  resident: GatewayPaymentResidentContext;
  cycleId: string;
  cycleKey: string;
  cycleTitle: string;
  payAllPending?: boolean;
  pendingCycleCount?: number;
}): Record<string, unknown> {
  return {
    orderId: params.orderId,
    cycleId: params.cycleId,
    cycleKey: params.cycleKey,
    cycleTitle: params.cycleTitle,
    societyName: params.resident.societyName,
    residentName: params.resident.residentName,
    residentEmail: params.resident.residentEmail,
    residentPhone: params.resident.residentPhone || undefined,
    villaNo: params.resident.villaLabel || undefined,
    maintenanceAmount: params.breakup.maintenanceAmount,
    platformFee: params.breakup.platformFee,
    platformFeeGst: params.breakup.platformFeeGst,
    totalPayable: params.breakup.totalPayable,
    payAllPending: params.payAllPending === true,
    pendingCycleCount: params.pendingCycleCount,
  };
}
