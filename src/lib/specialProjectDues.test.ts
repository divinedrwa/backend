import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  loadSpecialProjectDuesForVilla,
  sumSpecialProjectRemaining,
} from "./specialProjectDues.js";

describe("specialProjectDues", () => {
  it("returns remaining due per active project contribution", async () => {
    const fakeDb = {
      projectContribution: {
        findMany: async () => [
          {
            id: "c1",
            amount: new Prisma.Decimal(500),
            paidAmount: new Prisma.Decimal(200),
            status: "PARTIALLY_PAID",
            dueDate: new Date("2026-08-01T00:00:00.000Z"),
            project: { id: "p1", title: "Event fee", type: "EVENT" },
          },
          {
            id: "c2",
            amount: new Prisma.Decimal(1000),
            paidAmount: new Prisma.Decimal(0),
            status: "UNPAID",
            dueDate: null,
            project: { id: "p2", title: "Penalty", type: "OTHER" },
          },
        ],
      },
    };

    const dues = await loadSpecialProjectDuesForVilla(
      fakeDb as never,
      "soc1",
      "villa1",
    );
    assert.equal(dues.length, 2);
    assert.equal(dues[0]!.remainingDue, 300);
    assert.equal(dues[1]!.remainingDue, 1000);
    assert.equal(sumSpecialProjectRemaining(dues), 1300);
  });
});
