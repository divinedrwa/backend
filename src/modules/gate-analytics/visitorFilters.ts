import { Prisma, VisitorCheckpointType, VisitorStatus } from "@prisma/client";

/**
 * A visit where the person was actually let in (not a request that was rejected,
 * expired or closed before entry). Older rows lack `checkedInByGuardId`, so an
 * admit/override checkpoint or a pre-approval also counts.
 */
export const ADMITTED: Prisma.VisitorWhereInput = {
  status: { in: [VisitorStatus.CHECKED_IN, VisitorStatus.CHECKED_OUT] },
  OR: [
    { checkedInByGuardId: { not: null } },
    { preApprovedId: { not: null } },
    {
      checkpoints: {
        some: {
          checkpointType: {
            in: [VisitorCheckpointType.ADMITTED, VisitorCheckpointType.EMERGENCY_OVERRIDE],
          },
        },
      },
    },
  ],
};

/** Inside right now: admitted and no exit yet (any day). */
export const INSIDE_NOW: Prisma.VisitorWhereInput = {
  status: VisitorStatus.CHECKED_IN,
  checkOutAt: null,
  checkOutTime: null,
};

/** Waiting on a resident's reply right now. */
export const WAITING_NOW: Prisma.VisitorWhereInput = {
  status: VisitorStatus.PENDING_APPROVAL,
  checkOutAt: null,
};
