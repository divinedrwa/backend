import { NotificationCategory } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import {
  buildWaterStillOnReminder,
  isWaterTurnedOn,
  WATER_STILL_ON_NOTIFY_ROLES,
  waterStillOnReminderMinutes,
} from "../lib/waterEventAction";
import { notifyUsers } from "../services/notification.service";

type Db = typeof prisma;

export type WaterStillOnReminderDeps = {
  notify?: typeof notifyUsers;
  now?: () => Date;
};

/**
 * Finds water-ON events that have been ON for ≥ N minutes (default 30) with no
 * reminder yet. If the gate is still ON, pushes the actor who toggled it plus
 * all society admins. If a newer ON/OFF superseded the event, the reminder is
 * suppressed (marked sent) so we don't re-scan forever.
 *
 * Safe to run every minute under an advisory lock.
 */
export async function processWaterStillOnReminders(
  db: Db = prisma,
  deps: WaterStillOnReminderDeps = {},
): Promise<{
  checked: number;
  sent: number;
  suppressed: number;
}> {
  const notify = deps.notify ?? notifyUsers;
  const now = deps.now ?? (() => new Date());
  const minutes = waterStillOnReminderMinutes();
  const cutoff = new Date(now().getTime() - minutes * 60_000);

  const candidates = await db.waterSupplyEvent.findMany({
    where: {
      turnedOn: true,
      stillOnReminderSentAt: null,
      createdAt: { lte: cutoff },
    },
    include: {
      gate: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  let sent = 0;
  let suppressed = 0;

  for (const event of candidates) {
    const latest = await db.waterSupplyEvent.findFirst({
      where: { societyId: event.societyId, gateId: event.gateId },
      orderBy: { createdAt: "desc" },
      select: { id: true, turnedOn: true, action: true },
    });

    // Not the current state anymore (turned OFF or a newer ON) — suppress.
    if (!latest || latest.id !== event.id || !isWaterTurnedOn(latest)) {
      await db.waterSupplyEvent.update({
        where: { id: event.id },
        data: { stillOnReminderSentAt: now() },
      });
      suppressed += 1;
      continue;
    }

    // Claim before send so concurrent ticks don't double-notify.
    const claimed = await db.waterSupplyEvent.updateMany({
      where: { id: event.id, stillOnReminderSentAt: null },
      data: { stillOnReminderSentAt: now() },
    });
    if (claimed.count === 0) continue;

    try {
      const recipients = await db.user.findMany({
        where: {
          societyId: event.societyId,
          isActive: true,
          role: { in: WATER_STILL_ON_NOTIFY_ROLES },
        },
        select: { id: true },
      });

      const recipientIds = recipients.map((r) => r.id);
      if (recipientIds.length === 0) {
        logger.warn(
          { eventId: event.id, societyId: event.societyId },
          "[water-still-on] no active guard/admin recipients",
        );
        await db.waterSupplyEvent.update({
          where: { id: event.id },
          data: { stillOnReminderSentAt: null },
        });
        continue;
      }

      const notification = buildWaterStillOnReminder({
        gateName: event.gate?.name,
        minutesOn: minutes,
      });

      await notify(
        recipientIds,
        {
          title: notification.title,
          body: notification.body,
          data: {
            type: notification.type,
            eventId: event.id,
            gateId: event.gateId,
            societyId: event.societyId,
            turnedOn: "true",
          },
        },
        // SYSTEM cannot be muted — ops alert must reach guards/admins even if
        // WATER_SUPPLY category is disabled in notification preferences.
        { category: NotificationCategory.SYSTEM },
      );

      sent += 1;
      logger.info(
        {
          eventId: event.id,
          gateId: event.gateId,
          societyId: event.societyId,
          recipientCount: recipientIds.length,
          minutes,
        },
        "[water-still-on] reminder sent",
      );
    } catch (err) {
      // Allow retry on the next tick.
      await db.waterSupplyEvent.update({
        where: { id: event.id },
        data: { stillOnReminderSentAt: null },
      });
      logger.error({ err, eventId: event.id }, "[water-still-on] reminder send failed");
    }
  }

  return { checked: candidates.length, sent, suppressed };
}
