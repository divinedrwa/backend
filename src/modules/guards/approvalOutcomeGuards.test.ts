import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { resolveApprovalOutcomeGuardIds } from "./visitorResidentApproval.service.js";

// Guards: g1 created the visitor (Gate 1, off shift now), g2 on shift at Gate 2, g3 on shift at Gate 1,
// g4 on shift but deactivated, g5 not on shift.
const ACTIVE = new Set(["g1", "g2", "g3", "g5"]);

function fakePrisma(onShift: string[]) {
  return {
    guardShift: {
      findMany: async ({ where }: { where: { recurringDaily: boolean } }) =>
        where.recurringDaily ? [] : onShift.map((guardId) => ({ guardId, recurringDaily: false })),
    },
    user: {
      findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
        [...ACTIVE].filter((id) => !where.id || where.id.in.includes(id)).map((id) => ({ id })),
    },
  } as unknown as PrismaClient;
}

const sorted = (a: string[]) => [...a].sort();

describe("resolveApprovalOutcomeGuardIds", () => {
  it("tells the creating guard and every guard on shift, at any gate", async () => {
    const ids = await resolveApprovalOutcomeGuardIds({ prisma: fakePrisma(["g2", "g3"]), societyId: "s", createdByGuardId: "g1" });
    assert.deepEqual(sorted(ids), ["g1", "g2", "g3"]);
  });

  it("skips deactivated guards and guards off shift", async () => {
    const ids = await resolveApprovalOutcomeGuardIds({ prisma: fakePrisma(["g2", "g4"]), societyId: "s", createdByGuardId: null });
    assert.deepEqual(ids, ["g2"]);
  });

  it("does not repeat a guard who is both the creator and on shift", async () => {
    const ids = await resolveApprovalOutcomeGuardIds({ prisma: fakePrisma(["g1", "g2"]), societyId: "s", createdByGuardId: "g1" });
    assert.deepEqual(sorted(ids), ["g1", "g2"]);
  });

  it("falls back to every active guard when nobody qualifies", async () => {
    const ids = await resolveApprovalOutcomeGuardIds({ prisma: fakePrisma([]), societyId: "s", createdByGuardId: "gone" });
    assert.deepEqual(sorted(ids), ["g1", "g2", "g3", "g5"]);
  });
});
