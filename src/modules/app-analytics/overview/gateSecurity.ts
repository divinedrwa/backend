import { PatrolStatus, SOSStatus, VisitorType } from "@prisma/client";
import { localDateKey, localHour } from "../../../lib/societyTime";
import { ADMITTED, INSIDE_NOW, WAITING_NOW } from "../../gate-analytics/visitorFilters";
import {
  type Change,
  type Contact,
  type Db,
  type Period,
  DAY_MS,
  WEEKDAYS,
  countChange,
  flatLabel,
  formatDuration,
  hourLabel,
  median,
  pct,
} from "./common";

export const OPEN_SOS: SOSStatus[] = [
  SOSStatus.CREATED,
  SOSStatus.ACKNOWLEDGED,
  SOSStatus.IN_PROGRESS,
  SOSStatus.PENDING,
  SOSStatus.ACTIVE,
];

/** Visits in the period from the same person to the same flat that suggest a regular pass. */
const REGULAR_VISITS_PER_30_DAYS = 4;

export type GateSection = {
  letIn: number;
  letInChange: Change;
  requests: number;
  insideNow: number;
  waitingNow: number;
  answeredInApp: number;
  answeredInAppPct: number;
  gateRequests: number;
  /** Median minutes from the resident being asked to their reply in the app. */
  typicalReply: string | null;
  busiestHour: string | null;
  busiestDay: string | null;
  deliveries: { received: number; handedOver: number; waitingOverADay: number };
  vehicleEntries: number;
  /** Same person visiting the same flat often — should be a regular (pre-approved) pass. */
  regularVisitors: (Contact & { visits: number })[];
};

export type SecuritySection = {
  patrols: { planned: number; done: number; missed: number; donePct: number | null };
  sos: { total: number; open: number; typicalAck: string | null; typicalResolve: string | null };
  staff: { onRoll: number; presentToday: number };
};

export async function buildGate(db: Db, societyId: string, p: Period): Promise<GateSection> {
  const [letIn, prevLetIn, requestRows, insideNow, waitingNow, asked, parcelsIn, handedOver, waitingParcels, vehicles, visits] =
    await Promise.all([
      db.visitor.count({ where: { societyId, createdAt: { gte: p.from }, ...ADMITTED } }),
      db.visitor.count({ where: { societyId, createdAt: { gte: p.prevFrom, lt: p.from }, ...ADMITTED } }),
      db.visitor.findMany({ where: { societyId, createdAt: { gte: p.from } }, select: { createdAt: true } }),
      db.visitor.count({ where: { societyId, ...INSIDE_NOW } }),
      db.visitor.count({ where: { societyId, ...WAITING_NOW } }),
      db.visitorVilla.findMany({
        where: { visitor: { societyId, createdAt: { gte: p.from } }, notifiedAt: { not: null } },
        select: { notifiedAt: true, respondedAt: true },
      }),
      db.parcel.count({ where: { societyId, receivedAt: { gte: p.from } } }),
      db.parcel.count({
        where: { societyId, receivedAt: { gte: p.from }, status: { in: ["DELIVERED", "COLLECTED"] } },
      }),
      db.parcel.count({
        where: {
          societyId,
          status: { in: ["RECEIVED", "PENDING"] },
          receivedAt: { lt: new Date(p.now.getTime() - DAY_MS) },
        },
      }),
      db.gateVehicleLedger.count({ where: { societyId, entryAt: { gte: p.from } } }),
      db.visitor.findMany({
        where: {
          societyId,
          createdAt: { gte: p.from },
          visitorType: { notIn: [VisitorType.DELIVERY, VisitorType.CAB] },
          preApprovedId: null,
        },
        select: {
          name: true,
          phone: true,
          villaVisits: { select: { villa: { select: { id: true, villaNumber: true, block: true } } } },
        },
      }),
    ]);

  const answered = asked.filter((a) => a.respondedAt != null);
  const replyMinutes = answered
    .map((a) => (a.respondedAt!.getTime() - a.notifiedAt!.getTime()) / 60000)
    .filter((m) => m >= 0 && m < 12 * 60);
  const replyMedian = median(replyMinutes);

  // Busiest hour and weekday for gate requests (society local time).
  const byHour = new Array<number>(24).fill(0);
  const byDay = new Array<number>(7).fill(0);
  for (const r of requestRows) {
    byHour[localHour(r.createdAt)]! += 1;
    byDay[new Date(`${localDateKey(r.createdAt)}T00:00:00Z`).getUTCDay()]! += 1;
  }
  const topHour = requestRows.length ? byHour.indexOf(Math.max(...byHour)) : -1;
  const topDay = requestRows.length ? byDay.indexOf(Math.max(...byDay)) : -1;

  // Regular visitors: same phone to the same flat, scaled to the period length.
  const threshold = Math.max(2, Math.round((REGULAR_VISITS_PER_30_DAYS * p.days) / 30));
  const counts = new Map<string, { name: string; phone: string; flat: string; visits: number }>();
  for (const v of visits) {
    const phone = v.phone.replace(/\D/g, "").slice(-10);
    if (phone.length < 10) continue;
    for (const vv of v.villaVisits) {
      const key = `${phone}|${vv.villa.id}`;
      const row = counts.get(key) ?? { name: v.name, phone: v.phone, flat: flatLabel(vv.villa), visits: 0 };
      row.visits += 1;
      counts.set(key, row);
    }
  }
  const regularVisitors = [...counts.values()]
    .filter((r) => r.visits >= threshold)
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 10)
    .map((r) => ({ ...r, detail: `${r.visits} visits` }));

  return {
    letIn,
    letInChange: countChange(letIn, prevLetIn),
    requests: requestRows.length,
    insideNow,
    waitingNow,
    answeredInApp: answered.length,
    answeredInAppPct: pct(answered.length, asked.length),
    gateRequests: asked.length,
    typicalReply: replyMedian == null ? null : formatDuration(Math.max(1, replyMedian)),
    busiestHour: topHour >= 0 ? `${hourLabel(topHour)} – ${hourLabel((topHour + 1) % 24)}` : null,
    busiestDay: topDay >= 0 ? WEEKDAYS[topDay]! : null,
    deliveries: { received: parcelsIn, handedOver, waitingOverADay: waitingParcels },
    vehicleEntries: vehicles,
    regularVisitors,
  };
}

export async function buildSecurity(db: Db, societyId: string, p: Period): Promise<SecuritySection> {
  // Attendance rows store a plain date (midnight UTC), not a local timestamp.
  const today = new Date(`${localDateKey(p.now)}T00:00:00Z`);
  const [patrols, alerts, staffOnRoll, presentToday] = await Promise.all([
    db.guardPatrol.findMany({
      where: { societyId, scheduledTime: { gte: p.from, lt: p.now } },
      select: { status: true, scheduledTime: true },
    }),
    db.sOSAlert.findMany({
      where: { societyId, createdAt: { gte: p.from } },
      select: { status: true, createdAt: true, acknowledgedAt: true, resolvedAt: true },
    }),
    db.staff.count({ where: { societyId, isActive: true } }),
    db.staffAttendance.count({ where: { societyId, date: today } }),
  ]);

  // A planned round counts as missed once it's over an hour late and not done.
  const lateCutoff = p.now.getTime() - 60 * 60 * 1000;
  const done = patrols.filter((r) => r.status === PatrolStatus.COMPLETED).length;
  const missed = patrols.filter(
    (r) =>
      r.status === PatrolStatus.MISSED ||
      (r.status === PatrolStatus.SCHEDULED && r.scheduledTime.getTime() < lateCutoff),
  ).length;

  const ack = median(
    alerts.filter((a) => a.acknowledgedAt).map((a) => (a.acknowledgedAt!.getTime() - a.createdAt.getTime()) / 60000),
  );
  const resolve = median(
    alerts.filter((a) => a.resolvedAt).map((a) => (a.resolvedAt!.getTime() - a.createdAt.getTime()) / 60000),
  );

  return {
    patrols: {
      planned: patrols.length,
      done,
      missed,
      donePct: patrols.length ? pct(done, patrols.length) : null,
    },
    sos: {
      total: alerts.length,
      open: alerts.filter((a) => OPEN_SOS.includes(a.status)).length,
      typicalAck: ack == null ? null : formatDuration(Math.max(1, ack)),
      typicalResolve: resolve == null ? null : formatDuration(Math.max(1, resolve)),
    },
    staff: { onRoll: staffOnRoll, presentToday },
  };
}
