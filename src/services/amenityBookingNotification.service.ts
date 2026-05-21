import { BookingStatus, NotificationCategory } from "@prisma/client";
import { logger } from "../lib/logger";
import { NotificationService } from "./notification.service";

function statusLabel(s: BookingStatus): string {
  switch (s) {
    case "PENDING":
      return "Pending approval";
    case "CONFIRMED":
      return "Confirmed";
    case "CANCELLED":
      return "Cancelled";
    case "COMPLETED":
      return "Completed";
    default:
      return String(s);
  }
}

/**
 * Push + in-app notification when a booking’s status changes (admin calendar/bookings UI).
 * Targets the resident who made the booking.
 */
export async function notifyResidentAmenityBookingStatusChanged(params: {
  residentUserId: string;
  societyId: string;
  bookingId: string;
  amenityName: string;
  previousStatus: BookingStatus;
  newStatus: BookingStatus;
}): Promise<void> {
  try {
    if (params.previousStatus === params.newStatus) {
      return;
    }

    const shortName =
      params.amenityName.length > 48 ? `${params.amenityName.slice(0, 45)}…` : params.amenityName;
    const label = statusLabel(params.newStatus);

    await NotificationService.sendToUser(
      params.residentUserId,
      {
        title: "Amenity booking updated",
        body: `${shortName}: ${label}.`,
        data: {
          type: "amenity_booking_status",
          bookingId: params.bookingId,
          status: params.newStatus,
          societyId: params.societyId,
        },
      },
      { category: NotificationCategory.AMENITY },
    );
  } catch (e) {
    logger.error({ err: e, bookingId: params.bookingId }, "[amenity-booking-notify] failed");
  }
}
