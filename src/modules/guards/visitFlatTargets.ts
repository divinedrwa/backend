import type { Prisma, PrismaClient } from "@prisma/client";
import { residentLikeRoleFilter } from "../../lib/residentLike";

type Db = Pick<PrismaClient, "user"> | Prisma.TransactionClient;

/**
 * Who a guard's "flat only" selection (no floor and no person chosen) should reach.
 *
 * A villa can have several floors (units) with an owner and tenants on different floors. Resolving a
 * flat-only request to the villa's default unit asked only that floor, so residents living elsewhere
 * never saw the visitor. Instead: every floor that has an active resident, plus residents who have
 * no floor assigned (they are asked directly).
 */
export async function occupiedFloorsOfVilla(
  db: Db,
  params: { societyId: string; villaId: string },
): Promise<{ unitIds: string[]; unplacedResidentIds: string[] }> {
  const occupants = await db.user.findMany({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      isActive: true,
      ...residentLikeRoleFilter,
    },
    select: { id: true, unitId: true },
    orderBy: { id: "asc" },
  });
  const unitIds: string[] = [];
  for (const o of occupants) {
    if (o.unitId && !unitIds.includes(o.unitId)) unitIds.push(o.unitId);
  }
  return {
    unitIds,
    unplacedResidentIds: occupants.filter((o) => !o.unitId).map((o) => o.id),
  };
}
