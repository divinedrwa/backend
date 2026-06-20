import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

type Db = typeof prisma | Prisma.TransactionClient;

const villaVisitRowInclude = {
  visitor: true,
  villa: { select: { villaNumber: true, block: true } },
} as const;

/**
 * Prisma filter for villaVisits that belong to this resident's flat.
 * When the guard targeted a specific resident (`residentUserId`), the visit row may
 * use the villa default unit while the resident account has a different `unitId`.
 */
export function residentVisitorVillaVisitWhere(params: {
  villaId: string;
  userId: string;
  unitId?: string | null;
}): Prisma.VisitorVillaWhereInput {
  const { villaId, userId, unitId } = params;
  if (unitId) {
    return {
      villaId,
      OR: [{ unitId }, { residentUserId: userId }],
    };
  }
  return { villaId };
}

/** Resolve the VisitorVilla row this resident should act on for approve/reject. */
export async function findResidentVisitorVillaRow(
  db: Db,
  params: {
    visitorId: string;
    societyId: string;
    userId: string;
    villaId: string;
    unitId: string | null;
  },
) {
  const { visitorId, villaId, userId, unitId, societyId } = params;

  if (unitId) {
    const byUnit = await db.visitorVilla.findFirst({
      where: { visitorId, villaId, unitId },
      include: villaVisitRowInclude,
    });
    if (byUnit?.visitor.societyId === societyId) return byUnit;
  }

  const byTarget = await db.visitorVilla.findFirst({
    where: { visitorId, villaId, residentUserId: userId },
    include: villaVisitRowInclude,
  });
  if (byTarget?.visitor.societyId === societyId) return byTarget;

  const fallback = await db.visitorVilla.findFirst({
    where: { visitorId, villaId },
    include: villaVisitRowInclude,
  });
  if (fallback?.visitor.societyId === societyId) return fallback;

  return null;
}

export function visitorApprovalIncludeForResident(
  villaId: string,
  userId: string,
  unitId?: string | null,
) {
  return {
    gate: { select: { id: true, name: true } },
    villaVisits: {
      where: residentVisitorVillaVisitWhere({ villaId, userId, unitId }),
      include: {
        villa: { select: { id: true, villaNumber: true, block: true } },
        unit: { select: { id: true, label: true, unitCode: true } },
      },
    },
  } as const;
}
