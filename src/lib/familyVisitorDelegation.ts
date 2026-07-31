import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { residentLikeRoleFilter } from "./residentLike";

type Db = typeof prisma | Prisma.TransactionClient;

export function normalizePhoneDigits(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (da.length < 10 || db.length < 10) return false;
  return da.slice(-10) === db.slice(-10);
}

/**
 * Resolve the app user who should receive visitor approvals on behalf of a family member row.
 * Requires `canApproveVisitors` and a matching active resident account in the same villa.
 */
export async function resolveFamilyMemberLinkedUserId(
  db: Db,
  params: {
    societyId: string;
    villaId: string;
    phone?: string | null;
    linkedUserId?: string | null;
  },
): Promise<string | null> {
  if (params.linkedUserId) {
    const explicit = await db.user.findFirst({
      where: {
        id: params.linkedUserId,
        societyId: params.societyId,
        villaId: params.villaId,
        isActive: true,
        ...residentLikeRoleFilter,
      },
      select: { id: true },
    });
    if (explicit) return explicit.id;
  }

  const digits = normalizePhoneDigits(params.phone);
  if (digits.length < 10) return null;

  const candidates = await db.user.findMany({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      isActive: true,
      ...residentLikeRoleFilter,
      phone: { not: null },
    },
    select: { id: true, phone: true },
  });

  for (const u of candidates) {
    if (phonesMatch(u.phone, params.phone)) return u.id;
  }
  return null;
}

/** Active delegate user IDs for villas (family members with canApproveVisitors). */
export async function resolveFamilyVisitorDelegateUserIds(
  db: Db,
  params: { societyId: string; villaIds: string[] },
): Promise<string[]> {
  if (params.villaIds.length === 0) return [];

  const residents = await db.user.findMany({
    where: {
      societyId: params.societyId,
      villaId: { in: params.villaIds },
      isActive: true,
    },
    select: { id: true, villaId: true },
  });
  const residentIds = residents.map((r) => r.id);
  if (residentIds.length === 0) return [];

  const members = await db.familyMember.findMany({
    where: {
      residentId: { in: residentIds },
      canApproveVisitors: true,
    },
    select: {
      linkedUserId: true,
      phone: true,
      resident: { select: { villaId: true } },
    },
  });

  const ids = new Set<string>();
  for (const m of members) {
    const villaId = m.resident.villaId;
    if (!villaId || !params.villaIds.includes(villaId)) continue;

    if (m.linkedUserId) {
      const ok = await db.user.findFirst({
        where: {
          id: m.linkedUserId,
          societyId: params.societyId,
          villaId,
          isActive: true,
          ...residentLikeRoleFilter,
        },
        select: { id: true },
      });
      if (ok) ids.add(ok.id);
      continue;
    }

    const linked = await resolveFamilyMemberLinkedUserId(db, {
      societyId: params.societyId,
      villaId,
      phone: m.phone,
    });
    if (linked) ids.add(linked);
  }

  return [...ids];
}
