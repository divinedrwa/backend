/**
 * Single place for society-scoped **villa + resident user** wiring.
 *
 * Any new flow that assigns residents to villas (CSV import, admin APIs, seeds, scripts)
 * should use this module instead of duplicating Prisma calls — otherwise we drift again
 * (e.g. imports auto-create villas but POST /users did not).
 */

import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { Prisma, UserRole, ResidentType } from "@prisma/client";
import {
  ensureDefaultUnitAndBillingAccount,
  getOrCreateDefaultUnitIdForVilla,
} from "../lib/propertyInfrastructure";
import { prisma } from "../lib/prisma";

export function normalizeVillaLookupKey(villaNumber: string): string {
  return villaNumber.trim().toLowerCase();
}

/** Optional phone: empty string → undefined (DB optional). */
export function optionalTrimmedPhone(raw: string | undefined): string | undefined {
  const t = raw?.trim() ?? "";
  return t === "" ? undefined : t;
}

export function formatUserUniqueConstraintError(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    const target = (e.meta?.target as string[] | undefined) ?? [];
    const t = target.join(", ");
    if (t.includes("email")) return "Email already exists.";
    if (t.includes("username")) return "Username already exists.";
    return `Unique constraint failed (${t || "record"})`;
  }
  return e instanceof Error ? e.message : "Create failed";
}

export function usernameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "owner";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^\.+/, "");
  return cleaned.length >= 3 ? cleaned : `owner${cleaned || "user"}`;
}

export async function allocateUniqueUsername(base: string): Promise<string> {
  let candidate = base.slice(0, 50);
  if (candidate.length < 3) {
    candidate = `${candidate}usr`.slice(0, 50);
  }
  for (let n = 0; n < 10_000; n++) {
    const u = n === 0 ? candidate : `${candidate.slice(0, 42)}${n}`;
    const exists = await prisma.user.findUnique({ where: { username: u } });
    if (!exists) return u;
  }
  return `${candidate.slice(0, 30)}${randomBytes(4).toString("hex")}`;
}

export function generatedProvisioningPassword(): string {
  return randomBytes(12).toString("base64url").slice(0, 18);
}

export type ShellVillaResult =
  | { ok: true; villaId: string; created: boolean }
  | { ok: false; message: string };

/**
 * Find an existing villa or create a minimal row (floors 1, maintenance 0) for resident onboarding.
 * Updates `villaByLookupKey` when provided (CSV batch): keys are `normalizeVillaLookupKey(villaNumber)`.
 */
export async function findOrCreateShellVillaForResident(params: {
  societyId: string;
  displayVillaNumber: string;
  placeholderOwnerName: string;
  villaByLookupKey?: Map<string, string>;
}): Promise<ShellVillaResult> {
  const trimmed = params.displayVillaNumber.trim();
  const key = normalizeVillaLookupKey(trimmed);
  if (!key) {
    return { ok: false, message: "villaNumber is required" };
  }

  if (params.villaByLookupKey?.has(key)) {
    return { ok: true, villaId: params.villaByLookupKey.get(key)!, created: false };
  }

  const existing = await prisma.villa.findFirst({
    where: { societyId: params.societyId, villaNumber: trimmed },
  });
  if (existing) {
    params.villaByLookupKey?.set(key, existing.id);
    return { ok: true, villaId: existing.id, created: false };
  }

  try {
    const v = await prisma.$transaction(async (tx) => {
      const created = await tx.villa.create({
        data: {
          societyId: params.societyId,
          villaNumber: trimmed,
          floors: 1,
          ownerName: params.placeholderOwnerName,
          monthlyMaintenance: 0,
        },
      });
      await ensureDefaultUnitAndBillingAccount(tx, {
        societyId: params.societyId,
        villaId: created.id,
      });
      return created;
    });
    params.villaByLookupKey?.set(key, v.id);
    return { ok: true, villaId: v.id, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await prisma.villa.findFirst({
        where: { societyId: params.societyId, villaNumber: trimmed },
      });
      if (again) {
        params.villaByLookupKey?.set(key, again.id);
        return { ok: true, villaId: again.id, created: false };
      }
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Could not create villa for this villaNumber",
    };
  }
}

export type OwnerCredential = {
  line: number;
  username: string;
  email: string;
  temporaryPassword: string;
};

export type ProvisionImportedVillaOwnerResult =
  | { kind: "created"; usersCreated: 1; credential?: OwnerCredential }
  | { kind: "skipped_no_email" }
  | { kind: "skipped_email_taken"; email: string }
  | { kind: "error"; line: number; message: string };

/**
 * After a villa row is inserted (villas CSV), create owner RESIDENT login when `ownerEmail` is set.
 */
export async function provisionImportedVillaOwnerAccount(params: {
  societyId: string;
  villaId: string;
  line: number;
  ownerName: string;
  ownerEmail?: string;
  ownerPhone?: string;
  ownerUsernameRaw?: string;
  ownerPasswordRaw?: string;
}): Promise<ProvisionImportedVillaOwnerResult> {
  const ownerEmail = params.ownerEmail?.trim();
  if (!ownerEmail) {
    return { kind: "skipped_no_email" };
  }

  const taken = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (taken) {
    return { kind: "skipped_email_taken", email: ownerEmail };
  }

  const rawUser = params.ownerUsernameRaw?.trim().toLowerCase().replace(/\s/g, "") ?? "";
  const baseUsername = rawUser.length >= 3 ? rawUser : usernameFromEmail(ownerEmail);
  const username = await allocateUniqueUsername(baseUsername);
  const pwdRaw = params.ownerPasswordRaw?.trim() ?? "";
  const passwordPlain = pwdRaw.length >= 6 ? pwdRaw : generatedProvisioningPassword();
  const passwordWasGenerated = pwdRaw.length < 6;

  try {
    const passwordHash = await bcrypt.hash(passwordPlain, 10);
    const unitId = await getOrCreateDefaultUnitIdForVilla({
      societyId: params.societyId,
      villaId: params.villaId,
    });
    await prisma.user.create({
      data: {
        societyId: params.societyId,
        username,
        name: params.ownerName,
        email: ownerEmail,
        phone: optionalTrimmedPhone(params.ownerPhone),
        passwordHash,
        role: UserRole.RESIDENT,
        residentType: ResidentType.OWNER,
        villaId: params.villaId,
        unitId,
        moveInDate: new Date(),
        isActive: true,
      },
    });
    const credential: OwnerCredential | undefined = passwordWasGenerated
      ? {
          line: params.line,
          username,
          email: ownerEmail,
          temporaryPassword: passwordPlain,
        }
      : undefined;
    return { kind: "created", usersCreated: 1, credential };
  } catch (e) {
    return {
      kind: "error",
      line: params.line,
      message: formatUserUniqueConstraintError(e),
    };
  }
}

/** Map societyId → villa number list for batch imports (same as findMany + Map build). */
export async function loadVillaLookupMap(societyId: string): Promise<Map<string, string>> {
  const villas = await prisma.villa.findMany({
    where: { societyId },
    select: { id: true, villaNumber: true },
  });
  return new Map(villas.map((v) => [normalizeVillaLookupKey(v.villaNumber), v.id] as const));
}
