import { ComplaintPriority, ComplaintStatus, Prisma } from "@prisma/client";

/** Valid complaint status transitions (shared by complaints + complaint-analytics). */
export const COMPLAINT_VALID_TRANSITIONS: Record<ComplaintStatus, ComplaintStatus[]> = {
  OPEN: [ComplaintStatus.IN_PROGRESS, ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED],
  IN_PROGRESS: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED, ComplaintStatus.OPEN],
  RESOLVED: [ComplaintStatus.CLOSED, ComplaintStatus.OPEN],
  CLOSED: [ComplaintStatus.OPEN],
};

const SLA_HOURS: Record<ComplaintPriority, number> = {
  LOW: 168,
  MEDIUM: 72,
  HIGH: 24,
  URGENT: 6,
};

export function computeComplaintSlaDeadline(
  priority: ComplaintPriority,
  from: Date = new Date(),
): Date {
  return new Date(from.getTime() + SLA_HOURS[priority] * 3600_000);
}

export function assertComplaintStatusTransition(
  from: ComplaintStatus,
  to: ComplaintStatus,
): void {
  if (from === to) return;
  const allowed = COMPLAINT_VALID_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    const err = new Error(`Cannot transition from ${from} to ${to}`);
    (err as Error & { statusCode: number }).statusCode = 400;
    throw err;
  }
}

export function buildComplaintStatusUpdate(
  existing: { status: ComplaintStatus; resolvedAt: Date | null; priority: ComplaintPriority; createdAt: Date },
  next: { status: ComplaintStatus; priority?: ComplaintPriority; adminNotes?: string },
): Prisma.ComplaintUpdateInput {
  assertComplaintStatusTransition(existing.status, next.status);

  const updateData: Prisma.ComplaintUpdateInput = { status: next.status };

  if (next.adminNotes) {
    updateData.adminNotes = next.adminNotes;
  }

  if (next.status === ComplaintStatus.RESOLVED && !existing.resolvedAt) {
    updateData.resolvedAt = new Date();
  }

  if (next.status === ComplaintStatus.RESOLVED || next.status === ComplaintStatus.CLOSED) {
    updateData.slaDeadline = null;
    updateData.slaBreachNotifiedAt = null;
  }

  if (next.priority && next.priority !== existing.priority) {
    updateData.priority = next.priority;
    updateData.slaDeadline = computeComplaintSlaDeadline(next.priority, existing.createdAt);
  }

  return updateData;
}
