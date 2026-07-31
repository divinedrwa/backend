import type { Complaint } from "@prisma/client";

export type ComplaintSlaTimelineEvent = {
  key: string;
  label: string;
  at: string;
  state: "done" | "active" | "upcoming" | "breached";
  detail?: string;
};

export function buildComplaintSlaTimeline(complaint: Complaint): ComplaintSlaTimelineEvent[] {
  const now = Date.now();
  const status = complaint.status;
  const resolved =
    status === "RESOLVED" || status === "CLOSED" || complaint.resolvedAt != null;
  const inProgress = status === "IN_PROGRESS";
  const breached = complaint.slaBreachNotifiedAt != null;
  const slaPast =
    complaint.slaDeadline != null && complaint.slaDeadline.getTime() < now && !resolved;

  const events: ComplaintSlaTimelineEvent[] = [
    {
      key: "submitted",
      label: "Submitted",
      at: complaint.createdAt.toISOString(),
      state: "done",
      detail: "Your complaint was logged with the society office",
    },
  ];

  if (complaint.slaDeadline) {
    events.push({
      key: "sla_due",
      label: breached || slaPast ? "SLA deadline passed" : "Response due",
      at: complaint.slaDeadline.toISOString(),
      state: breached || slaPast ? "breached" : resolved ? "done" : inProgress ? "active" : "upcoming",
      detail: breached
        ? "The society missed the target response time"
        : "Target time for the office to respond",
    });
  }

  if (inProgress || resolved) {
    events.push({
      key: "in_progress",
      label: inProgress && !resolved ? "Under review" : "Review started",
      at: complaint.updatedAt.toISOString(),
      state: resolved ? "done" : "active",
      detail: "An admin is working on your complaint",
    });
  }

  if (complaint.slaBreachNotifiedAt) {
    events.push({
      key: "sla_breach",
      label: "SLA breach flagged",
      at: complaint.slaBreachNotifiedAt.toISOString(),
      state: "breached",
      detail: "Escalation alert was sent to society admins",
    });
  }

  if (complaint.resolvedAt) {
    events.push({
      key: "resolved",
      label: status === "CLOSED" ? "Closed" : "Resolved",
      at: complaint.resolvedAt.toISOString(),
      state: "done",
      detail: "Marked complete by the society office",
    });
  } else if (resolved) {
    events.push({
      key: "resolved",
      label: status === "CLOSED" ? "Closed" : "Resolved",
      at: complaint.updatedAt.toISOString(),
      state: "done",
    });
  }

  return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

export function enrichComplaintForResident<T extends Complaint>(complaint: T) {
  return {
    ...complaint,
    slaTimeline: buildComplaintSlaTimeline(complaint),
  };
}
