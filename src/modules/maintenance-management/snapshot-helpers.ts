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
