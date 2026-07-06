/** Total amount due on a villa snapshot (base maintenance + late fee). */
export function resolveSnapshotExpectedTotal(
  expectedAmount: unknown,
  lateFeeAmount?: unknown | null,
): number {
  return Number(expectedAmount) + Number(lateFeeAmount ?? 0);
}

/**
 * One step of the advance-credit walk — the single source of truth used by
 * every credit-walker variant (and the billing ledger's rolling balance
 * mirrors the same conservation rule).
 *
 * Conservation invariant: money in (cash + prior pool) equals money out
 * (applied to this cycle + pool carried forward). The pool is the villa's
 * money — it is NEVER discarded, regardless of how the current cycle was
 * funded. A cycle fully covered by its own cash simply passes the prior pool
 * through untouched (plus any cash overpayment on top).
 *
 * `applied` is capped at `expected` so a snapshot's paidAmount never exceeds
 * its obligation; the surplus lives in the returned pool instead.
 */
export function advanceCreditWalkStep(
  expected: number,
  cashThis: number,
  creditPool: number,
): { applied: number; creditPool: number } {
  // cashThis / creditPool may be transiently negative (refund rows, negative
  // unlinked adjustments injected into the pool) — let them net out here.
  const available = cashThis + creditPool;
  const e = Math.max(0, expected);
  return {
    applied: Math.min(e, Math.max(0, available)),
    creditPool: Math.max(0, available - e),
  };
}

export function refreshSnapshotStatus(
  expected: number,
  paid: number,
  dueDate: Date
): "PENDING" | "PARTIAL" | "PAID" | "OVERDUE" | "WAIVED" {
  const e = Math.round(expected * 100) / 100;
  const p = Math.round(paid * 100) / 100;
  if (e <= 0 && p <= 0) return "PENDING";
  if (p >= e) return "PAID";
  if (p > 0) return "PARTIAL";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  if (isFinite(due.getTime()) && today > due) return "OVERDUE";
  return "PENDING";
}
