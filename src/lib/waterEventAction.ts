import { UserRole } from "@prisma/client";
import { RESIDENT_LIKE_ROLES } from "./residentLike";

/** Normalize water toggle events — toggles store TURNED_ON/TURNED_OFF + turnedOn boolean. */
export function isWaterTurnedOn(event: {
  action?: string | null;
  turnedOn?: boolean | null;
}): boolean {
  if (typeof event.turnedOn === "boolean") return event.turnedOn;
  const action = (event.action ?? "").toUpperCase();
  return action === "ON" || action === "TURNED_ON";
}

export function isWaterTurnedOff(event: {
  action?: string | null;
  turnedOn?: boolean | null;
}): boolean {
  if (typeof event.turnedOn === "boolean") return !event.turnedOn;
  const action = (event.action ?? "").toUpperCase();
  return action === "OFF" || action === "TURNED_OFF";
}

/** Resident push when water is turned ON. */
export const WATER_SUPPLY_ON_NOTIFICATION = {
  title: "Water Supply Update",
  body: "Water supply will begin shortly.",
} as const;

/** Society roles notified when water is turned OFF (admins only — not residents). */
export const WATER_SUPPLY_OFF_NOTIFY_ROLES: UserRole[] = [
  UserRole.ADMIN,
  UserRole.RESIDENT_CUM_ADMIN,
];

export function buildWaterToggleNotification(params: {
  turnedOn: boolean;
  gateName?: string | null;
  reason?: string | null;
}): { roles: UserRole[]; title: string; body: string; type: string } {
  const gateLabel = params.gateName?.trim() || "the gate";

  if (params.turnedOn) {
    return {
      roles: [...RESIDENT_LIKE_ROLES],
      title: WATER_SUPPLY_ON_NOTIFICATION.title,
      body: WATER_SUPPLY_ON_NOTIFICATION.body,
      type: "WATER_SUPPLY_ON",
    };
  }

  const offBody =
    params.reason?.trim() ||
    `Water supply has been turned OFF at ${gateLabel}.`;

  return {
    roles: [...WATER_SUPPLY_OFF_NOTIFY_ROLES],
    title: "Water supply OFF",
    body: offBody,
    type: "WATER_SUPPLY_OFF",
  };
}
