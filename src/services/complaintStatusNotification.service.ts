import { ComplaintStatus, NotificationCategory, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { NotificationService } from "./notification.service";

function statusLabel(s: ComplaintStatus): string {
  switch (s) {
    case "OPEN":
      return "Open";
    case "IN_PROGRESS":
      return "In progress";
    case "RESOLVED":
      return "Resolved";
    case "CLOSED":
      return "Closed";
    default:
      return String(s);
  }
}

/**
 * Push + in-app notification when an admin changes complaint status.
 * Targets the filing resident if `residentId` is set; otherwise all active residents on that villa.
 */
export async function notifyResidentsComplaintStatusChanged(params: {
  complaintId: string;
  title: string;
  villaId: string;
  societyId: string;
  residentId: string | null;
  previousStatus: ComplaintStatus;
  newStatus: ComplaintStatus;
}): Promise<void> {
  try {
    if (params.previousStatus === params.newStatus) {
      return;
    }

    const shortTitle =
      params.title.length > 56 ? `${params.title.slice(0, 53)}...` : params.title;
    const label = statusLabel(params.newStatus);

    const payload = {
      title: "Complaint status updated",
      body: `"${shortTitle}" is now ${label}.`,
      data: {
        type: "complaint_status",
        complaintId: params.complaintId,
        status: params.newStatus,
        societyId: params.societyId,
      },
    };

    let userIds: string[] = [];
    if (params.residentId) {
      userIds = [params.residentId];
    } else {
      const residents = await prisma.user.findMany({
        where: {
          societyId: params.societyId,
          villaId: params.villaId,
          role: UserRole.RESIDENT,
          isActive: true,
        },
        select: { id: true },
      });
      userIds = residents.map((r) => r.id);
    }

    if (userIds.length === 0) {
      console.log("[complaint-notify] no recipients", { complaintId: params.complaintId });
      return;
    }

    for (const userId of userIds) {
      try {
        await NotificationService.sendToUser(userId, payload, {
          category: NotificationCategory.COMPLAINT,
        });
      } catch (e) {
        console.error("[complaint-notify] send failed", {
          userId,
          complaintId: params.complaintId,
          error: e,
        });
      }
    }
  } catch (e) {
    console.error("[complaint-notify] failed", e);
  }
}
