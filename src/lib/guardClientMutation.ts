import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export const GUARD_MUTATION_KINDS = {
  VISITOR_CHECK_IN: "VISITOR_CHECK_IN",
  VISITOR_CHECK_OUT: "VISITOR_CHECK_OUT",
} as const;

export type GuardMutationKind =
  (typeof GUARD_MUTATION_KINDS)[keyof typeof GUARD_MUTATION_KINDS];

/** Shared include for guard visitor check-in/out responses. */
export const guardVisitorDetailInclude = {
  villaVisits: {
    include: {
      villa: {
        select: {
          villaNumber: true,
        },
      },
      unit: { select: { unitCode: true, label: true } },
      resident: { select: { id: true, name: true, residentType: true } },
    },
  },
  gate: {
    select: {
      name: true,
    },
  },
} satisfies Prisma.VisitorInclude;

export async function findGuardClientMutation(
  societyId: string,
  clientMutationId: string,
) {
  return prisma.guardClientMutation.findUnique({
    where: {
      societyId_clientMutationId: { societyId, clientMutationId },
    },
  });
}

export async function fetchGuardVisitorDetail(visitorId: string) {
  return prisma.visitor.findUnique({
    where: { id: visitorId },
    include: guardVisitorDetailInclude,
  });
}

export async function recordGuardClientMutation(params: {
  societyId: string;
  guardUserId: string;
  clientMutationId: string;
  kind: GuardMutationKind;
  visitorId?: string;
}) {
  try {
    await prisma.guardClientMutation.create({ data: params });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return;
    }
    throw error;
  }
}
