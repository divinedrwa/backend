import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserRole } from "@prisma/client";
import {
  createPreApprovedVisitor,
  deactivatePreApprovedVisitor,
} from "./preApprovedVisitor.service";

function makeDb(overrides: Record<string, unknown> = {}) {
  const store: { parcel?: unknown; preApproved?: unknown } = {};
  return {
    villa: {
      findFirst: async () => ({ id: "villa1" }),
    },
    preApprovedVisitor: {
      count: async () => 0,
      findFirst: async (args: { where?: { otp?: string } }) => {
        if (args.where?.otp === "111111") return { id: "dup" };
        return null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: "pa1",
          otp: "654321",
          villa: { villaNumber: "101", block: "A" },
          approvedBy: { id: "u1", name: "Resident" },
          ...args.data,
        };
        store.preApproved = row;
        return row;
      },
      update: async () => ({ id: "pa1" }),
    },
    ...overrides,
  };
}

describe("preApprovedVisitor.service", () => {
  it("createPreApprovedVisitor rejects duplicate active phone", async () => {
    const db = makeDb({
      preApprovedVisitor: {
        count: async () => 0,
        findFirst: async (args: { where?: { phone?: string } }) =>
          args.where?.phone ? { id: "x", name: "Existing" } : null,
        create: async () => {
          throw new Error("should not create");
        },
      },
    });

    await assert.rejects(
      () =>
        createPreApprovedVisitor(db as never, {
          societyId: "s1",
          villaId: "villa1",
          approvedById: "u1",
          name: "Guest",
          phone: "9876543210",
        }),
      (err: Error & { statusCode?: number }) => {
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it("deactivatePreApprovedVisitor blocks resident from other villa", async () => {
    const db = makeDb({
      preApprovedVisitor: {
        findFirst: async () => ({ id: "pa1", villaId: "villa-other" }),
        update: async () => {
          throw new Error("should not update");
        },
      },
    });

    await assert.rejects(
      () =>
        deactivatePreApprovedVisitor(db as never, {
          id: "pa1",
          societyId: "s1",
          role: UserRole.RESIDENT,
          actorVillaId: "villa1",
        }),
      (err: Error & { statusCode?: number }) => {
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  });
});
