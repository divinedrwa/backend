import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComplaintPriority, ComplaintStatus } from "@prisma/client";
import {
  assertComplaintStatusTransition,
  buildComplaintStatusUpdate,
} from "./complaintLifecycle.service";

describe("complaintLifecycle.service", () => {
  it("allows OPEN → IN_PROGRESS", () => {
    assert.doesNotThrow(() =>
      assertComplaintStatusTransition(ComplaintStatus.OPEN, ComplaintStatus.IN_PROGRESS),
    );
  });

  it("rejects CLOSED → RESOLVED", () => {
    assert.throws(
      () => assertComplaintStatusTransition(ComplaintStatus.CLOSED, ComplaintStatus.RESOLVED),
      /Cannot transition/,
    );
  });

  it("sets resolvedAt when moving to RESOLVED", () => {
    const patch = buildComplaintStatusUpdate(
      {
        status: ComplaintStatus.OPEN,
        resolvedAt: null,
        priority: ComplaintPriority.MEDIUM,
        createdAt: new Date("2026-01-01"),
      },
      { status: ComplaintStatus.RESOLVED },
    );
    assert.equal(patch.status, ComplaintStatus.RESOLVED);
    assert.ok(patch.resolvedAt instanceof Date);
  });
});
