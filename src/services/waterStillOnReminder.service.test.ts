/**
 * Unit tests for processWaterStillOnReminders — fake Prisma + injectable notify.
 * No database / FCM required.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { NotificationCategory, UserRole } from "@prisma/client";
import { processWaterStillOnReminders } from "./waterStillOnReminder.service";

type EventRow = {
  id: string;
  societyId: string;
  gateId: string;
  guardId: string;
  turnedOn: boolean;
  action: string;
  createdAt: Date;
  stillOnReminderSentAt: Date | null;
  gate?: { name: string } | null;
};

type UserRow = { id: string; societyId: string; isActive: boolean; role: UserRole };

function fakeDb(opts: {
  events: EventRow[];
  users?: UserRow[];
}): PrismaClient {
  const events = opts.events.map((e) => ({ ...e }));
  const users = opts.users ?? [];

  return {
    waterSupplyEvent: {
      findMany: async (args: {
        where: {
          turnedOn: boolean;
          stillOnReminderSentAt: null;
          createdAt: { lte: Date };
        };
      }) => {
        return events
          .filter(
            (e) =>
              e.turnedOn === args.where.turnedOn &&
              e.stillOnReminderSentAt === null &&
              e.createdAt.getTime() <= args.where.createdAt.lte.getTime(),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, 100)
          .map((e) => ({
            ...e,
            gate: e.gate ?? { name: "Main Gate" },
          }));
      },
      findFirst: async (args: {
        where: { societyId: string; gateId: string };
        orderBy: { createdAt: "desc" };
      }) => {
        const match = events
          .filter(
            (e) => e.societyId === args.where.societyId && e.gateId === args.where.gateId,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return match
          ? { id: match.id, turnedOn: match.turnedOn, action: match.action }
          : null;
      },
      update: async (args: {
        where: { id: string };
        data: { stillOnReminderSentAt: Date | null };
      }) => {
        const row = events.find((e) => e.id === args.where.id);
        if (row) row.stillOnReminderSentAt = args.data.stillOnReminderSentAt;
        return row;
      },
      updateMany: async (args: {
        where: { id: string; stillOnReminderSentAt: null };
        data: { stillOnReminderSentAt: Date };
      }) => {
        const row = events.find(
          (e) => e.id === args.where.id && e.stillOnReminderSentAt === null,
        );
        if (!row) return { count: 0 };
        row.stillOnReminderSentAt = args.data.stillOnReminderSentAt;
        return { count: 1 };
      },
    },
    user: {
      findMany: async (args: {
        where: {
          societyId: string;
          isActive: boolean;
          role: { in: UserRole[] };
        };
      }) => {
        return users
          .filter(
            (u) =>
              u.societyId === args.where.societyId &&
              u.isActive === args.where.isActive &&
              args.where.role.in.includes(u.role),
          )
          .map((u) => ({ id: u.id }));
      },
    },
  } as unknown as PrismaClient;
}

describe("processWaterStillOnReminders", () => {
  const fixedNow = new Date("2026-07-27T12:00:00.000Z");
  const fortyMinAgo = new Date(fixedNow.getTime() - 40 * 60_000);
  const tenMinAgo = new Date(fixedNow.getTime() - 10 * 60_000);

  it("sends to actor + admins when ON event is still current after 30+ minutes", async () => {
    const notified: string[][] = [];
    const db = fakeDb({
      events: [
        {
          id: "evt-on",
          societyId: "soc1",
          gateId: "gate1",
          guardId: "guard1",
          turnedOn: true,
          action: "TURNED_ON",
          createdAt: fortyMinAgo,
          stillOnReminderSentAt: null,
          gate: { name: "North Gate" },
        },
      ],
      users: [
        {
          id: "admin1",
          societyId: "soc1",
          isActive: true,
          role: UserRole.ADMIN,
        },
        {
          id: "admin2",
          societyId: "soc1",
          isActive: true,
          role: UserRole.RESIDENT_CUM_ADMIN,
        },
        {
          id: "inactive-admin",
          societyId: "soc1",
          isActive: false,
          role: UserRole.ADMIN,
        },
        {
          id: "other-soc-admin",
          societyId: "soc2",
          isActive: true,
          role: UserRole.ADMIN,
        },
      ],
    });

    const result = await processWaterStillOnReminders(db, {
      now: () => fixedNow,
      notify: async (ids, payload, opts) => {
        notified.push([...ids].sort());
        assert.equal(payload.data?.type, "WATER_SUPPLY_STILL_ON");
        assert.match(payload.body ?? "", /North Gate/);
        assert.equal(opts?.category, NotificationCategory.WATER_SUPPLY);
      },
    });

    assert.deepEqual(result, { checked: 1, sent: 1, suppressed: 0 });
    assert.deepEqual(notified, [["admin1", "admin2", "guard1"]]);
  });

  it("suppresses when a later OFF event supersedes the ON", async () => {
    let notifyCalls = 0;
    const db = fakeDb({
      events: [
        {
          id: "evt-on",
          societyId: "soc1",
          gateId: "gate1",
          guardId: "guard1",
          turnedOn: true,
          action: "TURNED_ON",
          createdAt: fortyMinAgo,
          stillOnReminderSentAt: null,
        },
        {
          id: "evt-off",
          societyId: "soc1",
          gateId: "gate1",
          guardId: "guard1",
          turnedOn: false,
          action: "TURNED_OFF",
          createdAt: tenMinAgo,
          stillOnReminderSentAt: null,
        },
      ],
    });

    const result = await processWaterStillOnReminders(db, {
      now: () => fixedNow,
      notify: async () => {
        notifyCalls += 1;
      },
    });

    assert.deepEqual(result, { checked: 1, sent: 0, suppressed: 1 });
    assert.equal(notifyCalls, 0);
  });

  it("skips ON events younger than the reminder window", async () => {
    let notifyCalls = 0;
    const db = fakeDb({
      events: [
        {
          id: "evt-recent",
          societyId: "soc1",
          gateId: "gate1",
          guardId: "guard1",
          turnedOn: true,
          action: "TURNED_ON",
          createdAt: tenMinAgo,
          stillOnReminderSentAt: null,
        },
      ],
    });

    const result = await processWaterStillOnReminders(db, {
      now: () => fixedNow,
      notify: async () => {
        notifyCalls += 1;
      },
    });

    assert.deepEqual(result, { checked: 0, sent: 0, suppressed: 0 });
    assert.equal(notifyCalls, 0);
  });

  it("resets claim so next tick can retry when notify fails", async () => {
    const events: EventRow[] = [
      {
        id: "evt-on",
        societyId: "soc1",
        gateId: "gate1",
        guardId: "guard1",
        turnedOn: true,
        action: "TURNED_ON",
        createdAt: fortyMinAgo,
        stillOnReminderSentAt: null,
      },
    ];
    const db = fakeDb({ events });

    const result = await processWaterStillOnReminders(db, {
      now: () => fixedNow,
      notify: async () => {
        throw new Error("FCM down");
      },
    });

    assert.equal(result.sent, 0);
    assert.equal(events[0]!.stillOnReminderSentAt, null);
  });

  it("dedupes when the actor is also an admin", async () => {
    const notified: string[][] = [];
    const db = fakeDb({
      events: [
        {
          id: "evt-on",
          societyId: "soc1",
          gateId: "gate1",
          guardId: "admin1",
          turnedOn: true,
          action: "TURNED_ON",
          createdAt: fortyMinAgo,
          stillOnReminderSentAt: null,
        },
      ],
      users: [
        {
          id: "admin1",
          societyId: "soc1",
          isActive: true,
          role: UserRole.ADMIN,
        },
      ],
    });

    await processWaterStillOnReminders(db, {
      now: () => fixedNow,
      notify: async (ids) => {
        notified.push([...ids]);
      },
    });

    assert.deepEqual(notified, [["admin1"]]);
  });
});
