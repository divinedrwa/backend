/** Resolve callable number: shift duty phone first, then guard profile phone. */
export function resolveGuardDutyPhone(
  shift: { contactPhone?: string | null } | null | undefined,
  guard: { phone?: string | null } | null | undefined,
): string | null {
  const duty = shift?.contactPhone?.trim();
  if (duty) return duty;
  const profile = guard?.phone?.trim();
  return profile || null;
}
