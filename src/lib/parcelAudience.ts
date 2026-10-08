import type { Prisma } from "@prisma/client";
import { residentLikeRoleFilter } from "./residentLike";

/**
 * Who a parcel is for. A parcel can be tied to one floor (unit) of a flat, because a flat can have an
 * owner and tenants on different floors. A parcel with no floor is for the whole flat.
 */

/** Residents to notify: the parcel's floor, plus residents with no floor set (nobody is left out). */
export function parcelRecipientWhere(params: {
  societyId: string;
  villaId: string;
  unitId?: string | null;
}): Prisma.UserWhereInput {
  const { societyId, villaId, unitId } = params;
  return {
    societyId,
    villaId,
    isActive: true,
    ...residentLikeRoleFilter,
    ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}),
  };
}

/**
 * Parcels of the resident's flat that this resident may see: those for their own floor, those for the
 * whole flat, and, when the resident has no floor set, every parcel of the flat.
 */
export function parcelVisibleToResidentWhere(residentUnitId: string | null | undefined): Prisma.ParcelWhereInput {
  return residentUnitId ? { OR: [{ unitId: null }, { unitId: residentUnitId }] } : {};
}

/** "A-12" style label for a flat. */
export function flatLabelOf(villa: { block?: string | null; villaNumber: string }): string {
  const block = villa.block?.trim();
  return block ? `${block}-${villa.villaNumber}` : villa.villaNumber;
}

/** Adds `flatLabel` ("A-12") and `unitLabel` ("Ground floor") to a parcel loaded with its villa and unit. */
export function withFlatLabels<
  P extends {
    villa?: { block?: string | null; villaNumber: string } | null;
    unit?: { label: string } | null;
  },
>(parcel: P): P & { flatLabel: string | null; unitLabel: string | null } {
  return {
    ...parcel,
    flatLabel: parcel.villa ? flatLabelOf(parcel.villa) : null,
    unitLabel: parcel.unit?.label ?? null,
  };
}
