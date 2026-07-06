import type { Prisma } from "@prisma/client";

/** Normalize plate for storage and exact matching. */
export function normalizeRegistrationNumber(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, " ");
}

/** Digits-only form for partial numeric search (e.g. "5670" → KA01AB5670). */
export function registrationDigitsOnly(input: string): string {
  return input.replace(/\D/g, "");
}

export function buildApprovedVehicleSearchWhere(
  societyId: string,
  query?: string,
  category?: string,
  vehicleType?: string,
): Prisma.VehicleWhereInput {
  const where: Prisma.VehicleWhereInput = {
    societyId,
    status: "APPROVED",
  };

  const cat = typeof category === "string" ? category.trim().toUpperCase() : "";
  if (cat === "RESIDENT" || cat === "VISITOR" || cat === "OTHER") {
    where.registrationCategory = cat;
  }

  const type = typeof vehicleType === "string" ? vehicleType.trim().toUpperCase() : "";
  if (
    type === "TWO_WHEELER" ||
    type === "FOUR_WHEELER" ||
    type === "BICYCLE" ||
    type === "OTHER"
  ) {
    where.type = type;
  }

  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) return where;

  const compact = trimmed.replace(/\s+/g, "").toUpperCase();
  const digits = registrationDigitsOnly(trimmed);
  const or: Prisma.VehicleWhereInput[] = [
    { registrationNumber: { contains: compact, mode: "insensitive" } },
    { ownerLabel: { contains: trimmed, mode: "insensitive" } },
    { notes: { contains: trimmed, mode: "insensitive" } },
    { parkingSlot: { contains: trimmed, mode: "insensitive" } },
    { villa: { villaNumber: { contains: trimmed, mode: "insensitive" } } },
    { villa: { block: { contains: trimmed, mode: "insensitive" } } },
  ];

  if (digits.length >= 1) {
    or.push({ registrationDigits: { contains: digits } });
  }

  where.AND = [{ OR: or }];
  return where;
}

export function mapVehicleToApi(v: {
  id: string;
  registrationNumber: string;
  registrationDigits: string;
  type: string;
  make: string;
  model: string;
  color: string;
  parkingSlot: string | null;
  registrationCategory: string;
  source: string;
  status: string;
  ownerLabel: string | null;
  notes: string | null;
  createdAt: Date;
  villa: { id: string; villaNumber: string; block: string | null } | null;
}) {
  return {
    id: v.id,
    vehicleNumber: v.registrationNumber,
    registrationNumber: v.registrationNumber,
    registrationDigits: v.registrationDigits,
    vehicleType: v.type,
    type: v.type,
    make: v.make,
    model: v.model,
    color: v.color,
    parkingSlot: v.parkingSlot,
    registrationCategory: v.registrationCategory,
    source: v.source,
    status: v.status,
    ownerLabel: v.ownerLabel,
    notes: v.notes,
    villa: v.villa
      ? {
          id: v.villa.id,
          villaNumber: v.villa.villaNumber,
          block: v.villa.block,
        }
      : null,
    createdAt: v.createdAt,
  };
}

export const vehicleInclude = {
  villa: { select: { id: true, villaNumber: true, block: true } },
} as const;
