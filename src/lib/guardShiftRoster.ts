import { ShiftType } from "@prisma/client";

export const ROSTER_SHIFT_DURATIONS_HOURS = [8, 12] as const;
export type RosterShiftDurationHours = (typeof ROSTER_SHIFT_DURATIONS_HOURS)[number];

export type RosterSlot = {
  shiftType: ShiftType;
  recurringStartMinutes: number;
  recurringEndMinutes: number;
  slotIndex: number;
  label: string;
};

const SHIFT_TYPES_8H: ShiftType[] = [ShiftType.MORNING, ShiftType.EVENING, ShiftType.NIGHT];
const SHIFT_TYPES_12H: ShiftType[] = [ShiftType.MORNING, ShiftType.NIGHT];

function shiftTypesForDuration(hours: RosterShiftDurationHours): ShiftType[] {
  if (hours === 8) return SHIFT_TYPES_8H;
  return SHIFT_TYPES_12H;
}

function formatClockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Build contiguous recurring slots that cover 24 hours from [dayStartMinutes, dayStartMinutes).
 */
export function buildDailyRosterSlots(
  shiftDurationHours: RosterShiftDurationHours,
  dayStartMinutes: number,
): RosterSlot[] {
  if (!ROSTER_SHIFT_DURATIONS_HOURS.includes(shiftDurationHours)) {
    throw new Error(`shiftDurationHours must be one of ${ROSTER_SHIFT_DURATIONS_HOURS.join(", ")}`);
  }
  if (dayStartMinutes < 0 || dayStartMinutes > 1439) {
    throw new Error("dayStartMinutes must be between 0 and 1439");
  }

  const shiftCount = 24 / shiftDurationHours;
  const durationMinutes = shiftDurationHours * 60;
  const types = shiftTypesForDuration(shiftDurationHours);
  const slots: RosterSlot[] = [];

  for (let i = 0; i < shiftCount; i++) {
    const recurringStartMinutes = (dayStartMinutes + i * durationMinutes) % 1440;
    const recurringEndMinutes = (recurringStartMinutes + durationMinutes) % 1440;
    const endClock = (dayStartMinutes + (i + 1) * durationMinutes) % 1440;
    slots.push({
      shiftType: types[i] ?? ShiftType.MORNING,
      recurringStartMinutes,
      recurringEndMinutes,
      slotIndex: i,
      label: `${formatClockLabel(recurringStartMinutes)}–${formatClockLabel(endClock)}`,
    });
  }

  return slots;
}

export type RosterShiftCreateInput = {
  shiftType: ShiftType;
  recurringStartMinutes: number;
  recurringEndMinutes: number;
  contactPhone: string | null;
  notes: string | null;
};

export function buildRosterShiftRows(
  slots: RosterSlot[],
  contactPhones: (string | null | undefined)[] | undefined,
  notes: string | null | undefined,
): RosterShiftCreateInput[] {
  return slots.map((slot, i) => ({
    shiftType: slot.shiftType,
    recurringStartMinutes: slot.recurringStartMinutes,
    recurringEndMinutes: slot.recurringEndMinutes,
    contactPhone: contactPhones?.[i]?.trim() || null,
    notes: notes?.trim() || null,
  }));
}
