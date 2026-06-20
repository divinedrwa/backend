import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "@prisma/client";
import {
  VisitorMultiVillaApprovalMode,
  VisitorStatus,
  VisitorVillaApprovalStatus,
} from "@prisma/client";
import { recomputeVisitorAggregateApproval } from "./visitorResidentApproval.service.js";

describe("visitorResidentApproval.service recomputeVisitorAggregateApproval", () => {
  it("does not call $transaction when already inside a transaction client", async () => {
    let updatedTo: VisitorStatus | null = null;
    const tx = {
      visitor: {
        findFirst: async () => ({ status: VisitorStatus.PENDING_APPROVAL }),
        findUnique: async () => ({
          id: "vis1",
          status: VisitorStatus.APPROVED,
          villaVisits: [],
          gate: null,
        }),
        update: async ({ data }: { data: { status: VisitorStatus } }) => {
          updatedTo = data.status;
          return {};
        },
      },
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
    } as unknown as Prisma.TransactionClient;

    const result = await recomputeVisitorAggregateApproval(
      tx as Prisma.TransactionClient,
      "vis1",
      "soc1",
    );

    assert.equal(updatedTo, VisitorStatus.APPROVED);
    assert.equal(result.visitor?.status, VisitorStatus.APPROVED);
    assert.equal(result.transitioned, true);
    assert.equal("$transaction" in tx, false);
  });
});
