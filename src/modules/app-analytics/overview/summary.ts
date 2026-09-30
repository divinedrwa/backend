import { ComplaintStatus } from "@prisma/client";
import { ADMITTED } from "../../gate-analytics/visitorFilters";
import { type Db, formatRupees, periodFor, plural } from "./common";

/** "This week vs last week" in a few plain sentences. */
export async function buildWeeklySummary(db: Db, societyId: string): Promise<string[]> {
  const w = periodFor(7);
  const range = (prev: boolean) => (prev ? { gte: w.prevFrom, lt: w.from } : { gte: w.from });

  const count = async <T>(fn: (prev: boolean) => Promise<T>) => Promise.all([fn(false), fn(true)]);

  const [[letIn, prevLetIn], [money, prevMoney], [filed, prevFiled], [fixed], [people, prevPeople], [parcels]] =
    await Promise.all([
      count((prev) => db.visitor.count({ where: { societyId, createdAt: range(prev), ...ADMITTED } })),
      count((prev) =>
        db.maintenancePayment.aggregate({
          where: { societyId, paymentDate: range(prev), reversedAt: null, reversalOfPaymentId: null },
          _sum: { amount: true },
        }),
      ),
      count((prev) => db.complaint.count({ where: { societyId, createdAt: range(prev) } })),
      count((prev) =>
        db.complaint.count({
          where: {
            societyId,
            status: { in: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED] },
            resolvedAt: range(prev),
          },
        }),
      ),
      count((prev) =>
        db.appAnalyticsSession
          .findMany({ where: { societyId, startedAt: range(prev) }, select: { userId: true }, distinct: ["userId"] })
          .then((r) => r.length),
      ),
      count((prev) => db.parcel.count({ where: { societyId, receivedAt: range(prev) } })),
    ]);

  const compare = (now: number, before: number) =>
    now === before ? "same as last week" : now > before ? `up from ${before}` : `down from ${before}`;

  const received = Number(money._sum.amount ?? 0);
  const prevReceived = Number(prevMoney._sum.amount ?? 0);

  const lines = [
    `${plural(letIn, "visitor")} let in at the gate (${compare(letIn, prevLetIn)}), and ${plural(parcels, "delivery", "deliveries")} received.`,
    received > 0 || prevReceived > 0
      ? `${formatRupees(received)} maintenance received this week (${received === prevReceived ? "same as last week" : received > prevReceived ? `more than ${formatRupees(prevReceived)} last week` : `less than ${formatRupees(prevReceived)} last week`}).`
      : "No maintenance payments this week or last week.",
    filed || fixed
      ? `${plural(filed, "complaint")} filed and ${fixed} resolved (${filed === prevFiled ? "same number filed as last week" : filed > prevFiled ? "more filed than last week" : "fewer filed than last week"}).`
      : "No complaints filed or resolved this week.",
    `${plural(people, "person", "people")} used the app (${compare(people, prevPeople)}).`,
  ];
  return lines;
}
