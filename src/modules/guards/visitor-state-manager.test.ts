import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "@prisma/client";
import {
  VisitorMultiVillaApprovalMode,
  VisitorStatus,
  VisitorVillaApprovalStatus,
} from "@prisma/client";
import { admitPreApprovedVisitor, recomputeVisitorAggregateApproval } from "./visitor-state-manager.js";

function pendingVisitorMock(
  onUpdate: (s: VisitorStatus) => void,
  current: VisitorStatus = VisitorStatus.PENDING_APPROVAL,
) {
  return {
    findFirst: async () => ({ status: current }),
    findUnique: async () => ({ status: current }),
    updateMany: async ({ where, data }: { where: { status: VisitorStatus }; data: { status: VisitorStatus } }) => {
      if (where.status !== current) return { count: 0 };
      onUpdate(data.status);
      return { count: 1 };
    },
  };
}

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
      visitor: pendingVisitorMock((s) => (updatedTo = s)),
    } as unknown as Prisma.TransactionClient;

    const status = await recomputeVisitorAggregateApproval(tx, {
      visitorId: "vis1",
      societyId: "soc1",
    });

    assert.equal(status, VisitorStatus.APPROVED);
    assert.equal(updatedTo, VisitorStatus.APPROVED);
  });

  it("admits a guard-added walk-in straight away once residents approve", async () => {
    let status: VisitorStatus = VisitorStatus.PENDING_APPROVAL;
    const checkpoints: string[] = [];
    const tx = {
      society: {
        findUnique: async () => ({
          visitorMultiVillaApprovalMode: VisitorMultiVillaApprovalMode.ANY_ONE_APPROVAL,
        }),
      },
      visitorVilla: {
        findMany: async () => [{ approvalStatus: VisitorVillaApprovalStatus.APPROVED, villaId: "v1" }],
      },
      visitor: {
        findFirst: async () => ({ status }),
        findUnique: async () => ({ status, createdBy: "guard1", preApprovedId: null, visitorType: "GUEST" }),
        findUniqueOrThrow: async () => ({
          id: "vis4",
          societyId: "soc4",
          name: "Walk-in",
          status,
          villaVisits: [],
        }),
        updateMany: async ({ where, data }: { where: { status?: VisitorStatus }; data: { status: VisitorStatus } }) => {
          if (where.status && where.status !== status) return { count: 0 };
          status = data.status;
          return { count: 1 };
        },
      },
      visitorCheckpoint: {
        create: async ({ data }: { data: { checkpointType: string } }) => {
          checkpoints.push(data.checkpointType);
          return {};
        },
      },
      user: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient;

    const result = await recomputeVisitorAggregateApproval(tx, {
      visitorId: "vis4",
      societyId: "soc4",
      actorUserId: "resident1",
    });

    assert.equal(result, VisitorStatus.CHECKED_IN);
    assert.equal(status, VisitorStatus.CHECKED_IN);
    assert.deepEqual(checkpoints, ["APPROVED", "ADMITTED"]);
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
      visitor: pendingVisitorMock((s) => (updatedTo = s)),
    } as unknown as Prisma.TransactionClient;

    const status = await recomputeVisitorAggregateApproval(tx, {
      visitorId: "vis2",
      societyId: "soc2",
    });

    assert.equal(status, VisitorStatus.DENIED);
    assert.equal(updatedTo, VisitorStatus.DENIED);
  });

  it("never moves an already admitted visitor back to APPROVED", async () => {
    let updatedTo: VisitorStatus | null = null;
    const tx = {
      society: {
        findUnique: async () => ({
          visitorMultiVillaApprovalMode: VisitorMultiVillaApprovalMode.ANY_ONE_APPROVAL,
        }),
      },
      visitorVilla: {
        findMany: async () => [
          { approvalStatus: VisitorVillaApprovalStatus.APPROVED, villaId: "v1" },
        ],
      },
      visitor: pendingVisitorMock((s) => (updatedTo = s), VisitorStatus.CHECKED_IN),
    } as unknown as Prisma.TransactionClient;

    const status = await recomputeVisitorAggregateApproval(tx, {
      visitorId: "vis3",
      societyId: "soc3",
    });

    assert.equal(status, VisitorStatus.CHECKED_IN);
    assert.equal(updatedTo, null);
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
