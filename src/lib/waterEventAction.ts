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
