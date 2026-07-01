import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VisitorType } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { runVisitorApproveEntry } from "./visitorApproveEntryFlow.js";

function mockDb(overrides: {
  shift?: { gateId: string } | null;
  preApproved?: Record<string, unknown> | null;
  unitFound?: boolean;
}): PrismaClient {
  const { shift = { gateId: "g1" }, preApproved, unitFound = true } = overrides;
  return {
    guardShift: {
      findFirst: async () => shift,
      findMany: async () => [],
    },
    preApprovedVisitor: {
      findFirst: async () => preApproved,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        preApprovedVisitor: {
          findFirst: async () => preApproved,
          update: async () => ({}),
          // Atomic consume: updateMany with a status precondition; count > 0
          // means this request successfully consumed the pass.
          updateMany: async () => ({ count: 1 }),
        },
        visitor: {
          create: async () => ({
            id: "vis1",
            societyId: "s1",
            villaId: "v1",
            triggeredBy: "u1",
            name: "Test",
          }),
        },
        visitorVilla: {
          create: async () => ({}),
          findMany: async () => [{ villaId: "v1" }],
        },
        unit: {
          findFirst: async () => (unitFound ? { id: "default-unit-1" } : null),
        },
        user: {
          findMany: async () => [],
        },
        visitorCheckpoint: {
          create: async () => ({}),
        },
      };
      return fn(tx);
    },
  } as unknown as PrismaClient;
}

describe("runVisitorApproveEntry", () => {
  it("400 when no active shift", async () => {
    const db = {
      guardShift: { findFirst: async () => null, findMany: async () => [] },
    } as unknown as PrismaClient;
    const r = await runVisitorApproveEntry(db, {
      userId: "u1",
      societyId: "s1",
      otp: "1234",
      villaId: "v1",
    });
    assert.equal(r.status, 400);
  });

  it("404 when OTP row missing", async () => {
    const db = mockDb({ preApproved: null });
    const r = await runVisitorApproveEntry(db, {
      userId: "u1",
      societyId: "s1",
      otp: "1234",
      villaId: "v1",
    });
    assert.equal(r.status, 404);
    assert.equal(r.body["message"], "OTP not found or invalid");
  });

  it("409 when pre-approved already used", async () => {
    const db = mockDb({
      preApproved: {
        id: "pa1",
        isUsed: true,
        isActive: true,
        name: "A",
        phone: "1",
        visitorType: VisitorType.GUEST,
        purpose: null,
        validUntil: null,
      },
    });
    const r = await runVisitorApproveEntry(db, {
      userId: "u1",
      societyId: "s1",
      otp: "1234",
      villaId: "v1",
    });
    assert.equal(r.status, 409);
  });

  it("400 when OTP expired", async () => {
    const db = mockDb({
      preApproved: {
        id: "pa1",
        isUsed: false,
        isActive: true,
        name: "A",
        phone: "1",
        visitorType: VisitorType.GUEST,
        purpose: null,
        validUntil: new Date("2000-01-01T00:00:00.000Z"),
      },
    });
    const r = await runVisitorApproveEntry(db, {
      userId: "u1",
      societyId: "s1",
      otp: "1234",
      villaId: "v1",
      now: new Date("2026-06-01T12:00:00.000Z"),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body["message"], "Pre-approval has expired");
  });

  it("200 on happy path", async () => {
    const db = mockDb({
      preApproved: {
        id: "pa1",
        isUsed: false,
        isActive: true,
        name: "A",
        phone: "9999999999",
        visitorType: VisitorType.GUEST,
        purpose: null,
        validUntil: null,
      },
    });
    const r = await runVisitorApproveEntry(db, {
      userId: "u1",
      societyId: "s1",
      otp: "1234",
      villaId: "v1",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body["admitted"], true);
  });
});
