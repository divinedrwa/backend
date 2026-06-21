import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "@prisma/client";
import {
  VisitorMultiVillaApprovalMode,
  VisitorStatus,
  VisitorVillaApprovalStatus,
} from "@prisma/client";
import { admitPreApprovedVisitor, recomputeVisitorAggregateApproval } from "./visitor-state-manager.js";

describe("recomputeVisitorAggregateApproval", () => {
  it("returns APPROVED for ANY_ONE when one villa approves", async () => {
    let updatedTo: VisitorStatus | null = null;
    const tx = {
      society: {
        findUnique: async () => ({
          visitorMultiVillaApprovalMode: VisitorMultiVillaApprovalMode.ANY_ONE_APPROVAL,
        }),
      },
      visitorVilla: {
        findMany: async () => [
          { approvalStatus: VisitorVillaApprovalStatus.PENDING, villaId: "v1" },
          { approvalStatus: VisitorVillaApprovalStatus.APPROVED, villaId: "v2" },
        ],
      },
      visitor: {
        update: async ({ data }: { data: { status: VisitorStatus } }) => {
          updatedTo = data.status;
          return {};
        },
      },
    } as unknown as Prisma.TransactionClient;

    const status = await recomputeVisitorAggregateApproval(tx, {
      visitorId: "vis1",
      societyId: "soc1",
    });

    assert.equal(status, VisitorStatus.APPROVED);
    assert.equal(updatedTo, VisitorStatus.APPROVED);
  });

  it("returns DENIED for ALL_MUST_APPROVE when any villa rejects", async () => {
    let updatedTo: VisitorStatus | null = null;
    const tx = {
      society: {
        findUnique: async () => ({
          visitorMultiVillaApprovalMode: VisitorMultiVillaApprovalMode.ALL_VILLAS_REQUIRED,
        }),
      },
      visitorVilla: {
        findMany: async () => [
          { approvalStatus: VisitorVillaApprovalStatus.APPROVED, villaId: "v1" },
          { approvalStatus: VisitorVillaApprovalStatus.REJECTED, villaId: "v2" },
        ],
      },
      visitor: {
        update: async ({ data }: { data: { status: VisitorStatus } }) => {
          updatedTo = data.status;
          return {};
        },
      },
    } as unknown as Prisma.TransactionClient;

    const status = await recomputeVisitorAggregateApproval(tx, {
      visitorId: "vis2",
      societyId: "soc2",
    });

    assert.equal(status, VisitorStatus.DENIED);
    assert.equal(updatedTo, VisitorStatus.DENIED);
  });
});

describe("admitPreApprovedVisitor validity window", () => {
  function txWithPreApproval(row: Record<string, unknown>) {
    let updated = false;
    const tx = {
      preApprovedVisitor: {
        findFirst: async () => row,
        update: async () => {
          updated = true;
          return {};
        },
      },
    } as unknown as Prisma.TransactionClient;
    return { tx, didUpdate: () => updated };
  }

  it("rejects a pre-approval whose start time is in the future", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const { tx, didUpdate } = txWithPreApproval({
      id: "pa1",
      isRecurring: false,
      isUsed: false,
      maxUses: null,
      usedCount: 0,
      validFrom: future,
      validUntil: null,
      villa: { id: "v1", villaNumber: "101", block: "A" },
    });

    await assert.rejects(
      admitPreApprovedVisitor(tx, {
        preApprovedId: "pa1",
        gateId: "g1",
        guardUserId: "guard1",
        societyId: "soc1",
      }),
      /PRE_APPROVED_NOT_YET_VALID/,
    );
    // Must reject before consuming the pre-approval.
    assert.equal(didUpdate(), false);
  });
});
