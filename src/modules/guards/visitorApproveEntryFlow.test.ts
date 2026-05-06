import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VisitorType } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { runVisitorApproveEntry } from "./visitorApproveEntryFlow.js";

function mockDb(overrides: {
  shift?: { gateId: string } | null;
  preApproved?: Record<string, unknown> | null;
  updateCount?: number;
}): PrismaClient {
  const { shift = { gateId: "g1" }, preApproved, updateCount = 1 } = overrides;
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
          updateMany: async () => ({ count: updateCount }),
        },
        visitor: {
          create: async () => ({ id: "vis1" }),
          findUnique: async () => ({ id: "vis1", name: "Test" }),
        },
        visitorVilla: {
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
    assert.equal(r.body["message"], "OTP not found");
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
    assert.equal(r.body["message"], "OTP expired");
  });

  it("201 on happy path", async () => {
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
    assert.equal(r.status, 201);
    assert.equal(r.body["admitted"], true);
  });

  it("409 when optimistic lock fails inside transaction", async () => {
    const db = mockDb({
      preApproved: {
        id: "pa1",
        isUsed: false,
        isActive: true,
        name: "A",
        phone: "1",
        visitorType: VisitorType.GUEST,
        purpose: null,
        validUntil: null,
      },
      updateCount: 0,
    });
    const r = await runVisitorApproveEntry(db, {
      userId: "u1",
      societyId: "s1",
      otp: "1234",
      villaId: "v1",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body["message"], "OTP already used");
  });
});
