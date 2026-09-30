import { BookingStatus, ComplaintStatus, ContractStatus, SpecialProjectStatus } from "@prisma/client";
import { type Db, type Period, DAY_MS, formatRupees, median, pct } from "./common";

export const OPEN_COMPLAINT: ComplaintStatus[] = [ComplaintStatus.OPEN, ComplaintStatus.IN_PROGRESS];
const DONE_COMPLAINT: ComplaintStatus[] = [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED];
/** Open complaints older than this are overdue. */
export const OVERDUE_DAYS = 7;

export type ServiceSection = {
  complaints: {
    open: number;
    overdue: number;
    filed: number;
    resolved: number;
    typicalFixDays: number | null;
    topCategories: { label: string; count: number }[];
    /** Flats that filed two or more complaints in the period. */
    repeatFlats: number;
  };
  amenities: {
    bookings: number;
    cancelled: number;
    top: { label: string; count: number }[];
    /** Active amenities nobody booked in the period. */
    unused: string[];
  };
  notices: { published: number };
  alerts: {
    sent: number;
    opened: number;
    openedPct: number;
    /** Alerts the phone never received (push failed). */
    notDelivered: number;
  };
  contractsEnding: { title: string; vendor: string; endsOn: string; daysLeft: number }[];
  projects: { title: string; collected: string; target: string; pct: number }[];
};

export async function buildService(db: Db, societyId: string, p: Period): Promise<ServiceSection> {
  const in30Days = new Date(p.now.getTime() + 30 * DAY_MS);
  const [openComplaints, filed, resolved, bookings, amenities, notices, alerts, contracts, projects] =
    await Promise.all([
      db.complaint.findMany({
        where: { societyId, status: { in: OPEN_COMPLAINT } },
        select: { createdAt: true },
      }),
      db.complaint.findMany({
        where: { societyId, createdAt: { gte: p.from } },
        select: { category: true, villaId: true },
      }),
      db.complaint.findMany({
        where: { societyId, status: { in: DONE_COMPLAINT }, resolvedAt: { gte: p.from } },
        select: { createdAt: true, resolvedAt: true },
      }),
      db.amenityBooking.findMany({
        where: { societyId, startTime: { gte: p.from, lt: in30Days } },
        select: { status: true, amenityId: true, startTime: true },
      }),
      db.amenity.findMany({ where: { societyId, isActive: true }, select: { id: true, name: true } }),
      db.notice.count({
        where: {
          societyId,
          isPublished: true,
          OR: [{ publishedAt: { gte: p.from } }, { publishedAt: null, createdAt: { gte: p.from } }],
        },
      }),
      db.userNotification.findMany({
        where: { societyId, createdAt: { gte: p.from } },
        select: { readAt: true, pushSent: true, pushError: true },
      }),
      db.vendorContract.findMany({
        where: { societyId, status: ContractStatus.ACTIVE, endDate: { gte: p.now, lte: in30Days } },
        select: { title: true, endDate: true, vendor: { select: { name: true } } },
        orderBy: { endDate: "asc" },
        take: 10,
      }),
      db.specialProject.findMany({
        where: { societyId, status: SpecialProjectStatus.ACTIVE },
        select: { title: true, targetAmount: true, totalCollected: true },
        take: 5,
      }),
    ]);

  const categoryCounts = new Map<string, number>();
  const perFlat = new Map<string, number>();
  for (const c of filed) {
    const label = c.category?.trim() || "General";
    categoryCounts.set(label, (categoryCounts.get(label) ?? 0) + 1);
    perFlat.set(c.villaId, (perFlat.get(c.villaId) ?? 0) + 1);
  }
  const fixDays = resolved
    .filter((c) => c.resolvedAt)
    .map((c) => (c.resolvedAt!.getTime() - c.createdAt.getTime()) / DAY_MS)
    .filter((d) => d >= 0);
  const typicalFix = median(fixDays);

  // Bookings that fall inside the period (not the next-30-days lookahead).
  const inPeriod = bookings.filter((b) => b.startTime < p.now);
  const used = inPeriod.filter((b) => b.status !== BookingStatus.CANCELLED);
  const perAmenity = new Map<string, number>();
  for (const b of used) perAmenity.set(b.amenityId, (perAmenity.get(b.amenityId) ?? 0) + 1);
  const amenityName = new Map(amenities.map((a) => [a.id, a.name]));

  return {
    complaints: {
      open: openComplaints.length,
      overdue: openComplaints.filter((c) => p.now.getTime() - c.createdAt.getTime() > OVERDUE_DAYS * DAY_MS).length,
      filed: filed.length,
      resolved: resolved.length,
      typicalFixDays: typicalFix == null ? null : Math.round(typicalFix * 10) / 10,
      topCategories: [...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([label, count]) => ({ label, count })),
      repeatFlats: [...perFlat.values()].filter((n) => n >= 2).length,
    },
    amenities: {
      bookings: used.length,
      cancelled: inPeriod.length - used.length,
      top: [...perAmenity.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, count]) => ({ label: amenityName.get(id) ?? "Amenity", count })),
      unused: amenities.filter((a) => !perAmenity.has(a.id)).map((a) => a.name),
    },
    notices: { published: notices },
    alerts: {
      sent: alerts.length,
      opened: alerts.filter((a) => a.readAt).length,
      openedPct: pct(alerts.filter((a) => a.readAt).length, alerts.length),
      notDelivered: alerts.filter((a) => a.pushError).length,
    },
    contractsEnding: contracts.map((c) => ({
      title: c.title,
      vendor: c.vendor?.name ?? "Vendor",
      endsOn: c.endDate.toISOString(),
      daysLeft: Math.max(0, Math.ceil((c.endDate.getTime() - p.now.getTime()) / DAY_MS)),
    })),
    projects: projects.map((pr) => {
      const target = Number(pr.targetAmount);
      const got = Number(pr.totalCollected);
      return { title: pr.title, collected: formatRupees(got), target: formatRupees(target), pct: pct(got, target) };
    }),
  };
}
