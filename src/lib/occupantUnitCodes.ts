/**
 * Canonical occupant unit codes for a property (`Villa`).
 * Single source of truth for CSV import, shell villas, and admin-suggested tiers.
 *
 * Pattern: `{stem}{suffix}` — e.g. villa "V-03" → stem `V03` → `V03_GF`, `V03_FF`, `V03_SF`.
 * Manual / custom unit codes are not validated here.
 */

const MAX_UNIT_CODE_LEN = 64;
/** Reserve room for longest suffix `_F10`. */
const MAX_STEM_LEN = MAX_UNIT_CODE_LEN - 4;

export const SUGGESTED_UNIT_SUFFIX_GF = "_GF";
export const SUGGESTED_UNIT_SUFFIX_FF = "_FF";
export const SUGGESTED_UNIT_SUFFIX_SF = "_SF";

const FLOOR_LABELS = [
  "Ground floor",
  "First floor",
  "Second floor",
  "Third floor",
  "Fourth floor",
  "Fifth floor",
  "Sixth floor",
  "Seventh floor",
  "Eighth floor",
  "Ninth floor",
] as const;

/** Stable suffix for auto tier `i` (0 = ground …). */
export function suggestedUnitSuffixForFloorIndex(i: number): string {
  if (i === 0) return SUGGESTED_UNIT_SUFFIX_GF;
  if (i === 1) return SUGGESTED_UNIT_SUFFIX_FF;
  if (i === 2) return SUGGESTED_UNIT_SUFFIX_SF;
  return `_F${i + 1}`;
}

/**
 * Stem used before `_GF` / `_FF` / …
 * - "V-03", "v 03" → `V03` (no doubled `V`)
 * - "03" → `V03`
 * - "A-101" → `VA101`
 */
export function occupantUnitCodeStem(villaNumber: string): string {
  const slug = villaNumber.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const raw = slug.length > 0 ? slug : "VILLA";
  if (/^\d+$/.test(raw)) {
    const body = raw.length === 1 ? raw.padStart(2, "0") : raw;
    return (`V${body}`).slice(0, MAX_STEM_LEN);
  }
  if (raw.length < 2) {
    return "VILLA".slice(0, MAX_STEM_LEN);
  }
  if (/^V[A-Z0-9]/.test(raw)) {
    return raw.slice(0, MAX_STEM_LEN);
  }
  return (`V${raw}`).slice(0, MAX_STEM_LEN);
}

export function occupantUnitLabelForFloorIndex(floorIndex: number): string {
  return FLOOR_LABELS[floorIndex] ?? `Floor ${floorIndex + 1}`;
}

export function occupantUnitCodeForFloorIndex(villaNumber: string, floorIndex: number): string {
  const stem = occupantUnitCodeStem(villaNumber);
  return `${stem}${suggestedUnitSuffixForFloorIndex(floorIndex)}`.slice(0, MAX_UNIT_CODE_LEN);
}

/**
 * @deprecated Old layout `V` + 48-char slug + suffix (produced `VV03_GF` for "V-03"). Kept so admin UI can still recognize legacy rows.
 */
export function legacyOccupantUnitCodeForFloorIndex(villaNumber: string, floorIndex: number): string {
  const slug = villaNumber.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const base = (slug.length > 0 ? slug : "VILLA").slice(0, 48);
  return (`V${base}${suggestedUnitSuffixForFloorIndex(floorIndex)}`).slice(0, MAX_UNIT_CODE_LEN);
}

export function inferCanonicalTierIndex(villaNumber: string, unitCode: string): number | null {
  const t = unitCode.trim();
  const maxSlots = 48;
  for (let i = 0; i < maxSlots; i++) {
    if (occupantUnitCodeForFloorIndex(villaNumber, i) === t) return i;
    if (legacyOccupantUnitCodeForFloorIndex(villaNumber, i) === t) return i;
  }
  return null;
}

/** Smallest non-negative slot index not already used for this form. */
export function nextFreeOccupantSlotIndex(usedSlots: ReadonlySet<number>): number {
  let n = 0;
  while (usedSlots.has(n)) n++;
  return n;
}

export type SuggestedOccupantUnitDef = {
  unitCode: string;
  label: string;
  sortOrder: number;
  isDefault: boolean;
};

/**
 * Definitions for `floorCount` occupant tiers (1–10), e.g. floors=3 → GF, FF, SF.
 * Lowest sortOrder is default for billing / visitor fallback.
 */
export function suggestedOccupantUnitDefinitions(
  villaNumber: string,
  floorCount: number,
): SuggestedOccupantUnitDef[] {
  const n = Math.min(10, Math.max(1, Math.floor(floorCount)));
  const out: SuggestedOccupantUnitDef[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      unitCode: occupantUnitCodeForFloorIndex(villaNumber, i),
      label: occupantUnitLabelForFloorIndex(i),
      sortOrder: i * 10,
      isDefault: i === 0,
    });
  }
  return out;
}
