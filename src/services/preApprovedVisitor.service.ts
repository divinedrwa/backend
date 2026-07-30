import { randomInt } from "node:crypto";
import { UserRole, type Prisma, type PrismaClient, type VisitorType } from "@prisma/client";
import { logger } from "../lib/logger";
import { defaultValidUntilForVisitorType } from "../lib/visitorTypePresets";
import {
  buildVisitorPublicPassUrl,
  createVisitorPublicPassToken,
} from "../lib/visitorPublicPass";
import { notifyGuardsPreApprovedCreated } from "../modules/guards/visitorResidentApproval.service";

/** Max active (unused) pre-approvals allowed per villa. */
export const MAX_ACTIVE_PRE_APPROVALS_PER_VILLA = 20;

export type CreatePreApprovedVisitorInput = {
  societyId: string;
  villaId: string;
  approvedById: string;
  name: string;
  phone: string;
  purpose?: string;
  visitorType?: VisitorType;
  validFrom?: Date;
  validUntil?: Date | null;
  isRecurring?: boolean;
  maxUses?: number | null;
};

export type PreApprovedListFilters = {
  societyId: string;
  villaId?: string;
  /** When true, only non-expired passes that can still be used at the gate. */
  gateEligibleOnly?: boolean;
  take?: number;
  skip?: number;
};

/** Generate a crypto-secure 6-digit OTP unique among active pre-approvals in the society. */
export async function generateUniquePreApprovalOtp(
  db: PrismaClient | Prisma.TransactionClient,
  societyId: string,
  maxAttempts = 25,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const otp = randomInt(100000, 999999).toString();
    const exists = await db.preApprovedVisitor.findFirst({
      where: { societyId, otp, isActive: true, isUsed: false },
      select: { id: true },
    });
    if (!exists) return otp;
  }
  // Never return an unchecked (possibly duplicate) OTP: admission resolves a
  // pass by OTP alone, so a collision could admit the wrong visitor/flat.
  const err = new Error(
    "Could not generate a unique visitor code right now. Please try again.",
  );
  (err as Error & { statusCode: number }).statusCode = 503;
  throw err;
}

export function isPreApprovalGateEligible(
  row: {
    validFrom?: Date | null;
    validUntil: Date | null;
    isRecurring: boolean;
    maxUses: number | null;
    usedCount: number;
    isActive: boolean;
    isUsed: boolean;
  },
  now = new Date(),
): boolean {
  if (!row.isActive) return false;
  if (row.validFrom && new Date(row.validFrom) > now) return false;
  if (row.validUntil && new Date(row.validUntil) <= now) return false;
  if (row.isRecurring) {
    if (row.maxUses && row.usedCount >= row.maxUses) return false;
    return true;
  }
  return !row.isUsed;
}

export async function createPreApprovedVisitor(
  db: PrismaClient,
  input: CreatePreApprovedVisitorInput,
) {
  const phone = input.phone.replace(/\D/g, "");
  if (phone.length < 10) {
    const err = new Error("phone must have at least 10 digits");
    (err as Error & { statusCode: number }).statusCode = 400;
    throw err;
  }

  if (input.validUntil && input.validUntil.getTime() <= Date.now() - 60_000) {
    const err = new Error("Visit end date/time must be in the future.");
    (err as Error & { statusCode: number }).statusCode = 400;
    throw err;
  }

  const villa = await db.villa.findFirst({
    where: { id: input.villaId, societyId: input.societyId },
    select: { id: true },
  });
  if (!villa) {
    const err = new Error("Villa not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }

  const activeCount = await db.preApprovedVisitor.count({
    where: {
      villaId: input.villaId,
      societyId: input.societyId,
      isActive: true,
      isUsed: false,
      OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
    },
  });
  if (activeCount >= MAX_ACTIVE_PRE_APPROVALS_PER_VILLA) {
    const err = new Error(
      `Maximum ${MAX_ACTIVE_PRE_APPROVALS_PER_VILLA} active pre-approvals per flat. Please remove expired or unused entries first.`,
    );
    (err as Error & { statusCode: number }).statusCode = 400;
    throw err;
  }

  const duplicatePhone = await db.preApprovedVisitor.findFirst({
    where: {
      villaId: input.villaId,
      societyId: input.societyId,
      phone,
      isActive: true,
      isUsed: false,
      OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
    },
    select: { id: true, name: true },
  });
  if (duplicatePhone) {
    const err = new Error(
      `An active pre-approval already exists for this phone number (${duplicatePhone.name}). Remove it first or use a different number.`,
    );
    (err as Error & { statusCode: number }).statusCode = 409;
    throw err;
  }

  const otp = await generateUniquePreApprovalOtp(db, input.societyId);
  const isRecurring = input.isRecurring ?? false;
  const visitorType = input.visitorType ?? "GUEST";
  const validFrom = input.validFrom ?? new Date();
  // Type presets: cab/delivery get short windows when client omits validUntil.
  const validUntil =
    input.validUntil ?? defaultValidUntilForVisitorType(visitorType, validFrom);
  const publicPass = createVisitorPublicPassToken();

  const preApproved = await db.preApprovedVisitor.create({
    data: {
      societyId: input.societyId,
      villaId: input.villaId,
      name: input.name.trim(),
      phone,
      purpose: input.purpose?.trim() || undefined,
      visitorType,
      validFrom,
      validUntil,
      otp,
      publicPassTokenHash: publicPass.tokenHash,
      publicPassIssuedAt: new Date(),
      approvedById: input.approvedById,
      isActive: true,
      isRecurring,
      maxUses: isRecurring ? (input.maxUses ?? null) : null,
    },
    include: {
      villa: { select: { villaNumber: true, block: true } },
      approvedBy: { select: { id: true, name: true } },
    },
  });

  try {
    await notifyGuardsPreApprovedCreated({
      prisma: db,
      societyId: input.societyId,
      preApprovedId: preApproved.id,
      visitorName: preApproved.name,
      visitorPhone: preApproved.phone,
      villa: preApproved.villa,
    });
  } catch (notifyErr) {
    logger.error({ err: notifyErr }, "[createPreApprovedVisitor] guard notify error");
  }

  return {
    ...preApproved,
    publicPassUrl: buildVisitorPublicPassUrl(publicPass.rawToken),
  };
}

export async function listPreApprovedVisitors(
  db: PrismaClient,
  filters: PreApprovedListFilters,
) {
  const where: Prisma.PreApprovedVisitorWhereInput = {
    societyId: filters.societyId,
    isActive: true,
  };
  if (filters.villaId) where.villaId = filters.villaId;

  const rows = await db.preApprovedVisitor.findMany({
    where,
    include: {
      villa: { select: { villaNumber: true, block: true } },
      approvedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    ...(filters.gateEligibleOnly
      ? {}
      : { take: filters.take, skip: filters.skip }),
  });

  const now = new Date();
  const gateEligible = rows.filter((v) => isPreApprovalGateEligible(v, now));
  let visible = filters.gateEligibleOnly ? gateEligible : rows;

  if (filters.gateEligibleOnly && (filters.skip || filters.take)) {
    const skip = filters.skip ?? 0;
    const take = filters.take ?? visible.length;
    visible = visible.slice(skip, skip + take);
  }

  return {
    rows: visible,
    gateEligible,
    summary: {
      total: filters.gateEligibleOnly ? gateEligible.length : rows.length,
      active: gateEligible.length,
      expired: rows.length - gateEligible.length,
    },
  };
}

export async function deactivatePreApprovedVisitor(
  db: PrismaClient,
  p: {
    id: string;
    societyId: string;
    role: UserRole;
    actorVillaId?: string | null;
  },
) {
  const existing = await db.preApprovedVisitor.findFirst({
    where: { id: p.id, societyId: p.societyId },
  });
  if (!existing) {
    const err = new Error("Pre-approved visitor not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }

  if (p.role === UserRole.RESIDENT) {
    if (!p.actorVillaId || existing.villaId !== p.actorVillaId) {
      const err = new Error("Cannot remove pre-approval for another villa");
      (err as Error & { statusCode: number }).statusCode = 403;
      throw err;
    }
  }

  await db.preApprovedVisitor.update({
    where: { id: p.id },
    data: { isActive: false },
  });
}

type PrivatePublicPassFields = {
  publicPassTokenHash?: string | null;
  publicPassIssuedAt?: Date | string | null;
};

/** Never serialize the stored token hash to resident/admin/guard clients. */
export function mapPreApprovedForClient<
  T extends PrivatePublicPassFields,
>(row: T): Omit<T, keyof PrivatePublicPassFields> {
  const {
    publicPassTokenHash,
    publicPassIssuedAt,
    ...safe
  } = row;
  void publicPassTokenHash;
  void publicPassIssuedAt;
  return safe;
}

export function mapPreApprovedForMobile<
  T extends PrivatePublicPassFields & { otp: string | null },
>(row: T) {
  return { ...mapPreApprovedForClient(row), passcode: row.otp };
}

export async function issuePreApprovedVisitorPublicLink(
  db: PrismaClient,
  p: {
    id: string;
    societyId: string;
    role: UserRole;
    actorVillaId?: string | null;
  },
): Promise<{ publicPassUrl: string }> {
  const baseCheck = buildVisitorPublicPassUrl("x".repeat(43));
  if (!baseCheck) {
    const err = new Error(
      "Visitor pass URL is not configured. Set VISITOR_PASS_BASE_URL or FRONTEND_URL.",
    );
    (err as Error & { statusCode: number }).statusCode = 503;
    throw err;
  }

  const existing = await db.preApprovedVisitor.findFirst({
    where: { id: p.id, societyId: p.societyId },
    select: {
      id: true,
      villaId: true,
      isActive: true,
      isUsed: true,
      isRecurring: true,
      maxUses: true,
      usedCount: true,
      validFrom: true,
      validUntil: true,
    },
  });
  if (!existing) {
    const err = new Error("Pre-approved visitor not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }
  if (
    p.role === UserRole.RESIDENT &&
    (!p.actorVillaId || existing.villaId !== p.actorVillaId)
  ) {
    const err = new Error("Cannot share a pre-approval for another villa");
    (err as Error & { statusCode: number }).statusCode = 403;
    throw err;
  }
  if (!isPreApprovalGateEligible(existing)) {
    const err = new Error("Only an active visitor pass can be shared");
    (err as Error & { statusCode: number }).statusCode = 409;
    throw err;
  }

  const issued = createVisitorPublicPassToken();
  await db.preApprovedVisitor.update({
    where: { id: existing.id },
    data: {
      publicPassTokenHash: issued.tokenHash,
      publicPassIssuedAt: new Date(),
    },
  });

  return {
    publicPassUrl: buildVisitorPublicPassUrl(issued.rawToken)!,
  };
}
