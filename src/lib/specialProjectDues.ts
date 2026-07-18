import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export type SpecialProjectDueDto = {
  projectId: string;
  contributionId: string;
  title: string;
  type: string;
  amount: number;
  paidAmount: number;
  remainingDue: number;
  dueDate: string | null;
  status: string;
};

type Db = Pick<typeof prisma, "projectContribution">;

/** Unpaid/partial contributions on ACTIVE special projects for one villa (A10 ad-hoc dues). */
export async function loadSpecialProjectDuesForVilla(
  db: Db,
  societyId: string,
  villaId: string,
): Promise<SpecialProjectDueDto[]> {
  const rows = await db.projectContribution.findMany({
    where: {
      villaId,
      status: { in: ["UNPAID", "PARTIALLY_PAID"] },
      project: { societyId, status: "ACTIVE" },
    },
    select: {
      id: true,
      amount: true,
      paidAmount: true,
      status: true,
      dueDate: true,
      project: {
        select: { id: true, title: true, type: true },
      },
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
  });

  return rows.map((row) => {
    const amount = Number(row.amount);
    const paidAmount = Number(row.paidAmount);
    const remainingDue = Math.round(Math.max(0, amount - paidAmount) * 100) / 100;
    return {
      projectId: row.project.id,
      contributionId: row.id,
      title: row.project.title,
      type: row.project.type,
      amount,
      paidAmount,
      remainingDue,
      dueDate: row.dueDate?.toISOString() ?? null,
      status: row.status,
    };
  });
}

export function sumSpecialProjectRemaining(dues: SpecialProjectDueDto[]): number {
  return Math.round(dues.reduce((sum, d) => sum + d.remainingDue, 0) * 100) / 100;
}

export type CreateSpecialProjectInput = {
  societyId: string;
  createdById: string;
  title: string;
  description?: string;
  type: "REPAIR" | "UPGRADE" | "PURCHASE" | "EVENT" | "OTHER";
  targetAmount: number;
  contributions: Array<{ villaId: string; amount: number; dueDate?: Date | null }>;
};

export async function createSpecialProjectWithContributions(
  tx: Prisma.TransactionClient,
  input: CreateSpecialProjectInput,
) {
  return tx.specialProject.create({
    data: {
      societyId: input.societyId,
      title: input.title,
      description: input.description,
      type: input.type,
      targetAmount: input.targetAmount,
      createdById: input.createdById,
      contributions: {
        create: input.contributions.map((c) => ({
          villaId: c.villaId,
          amount: c.amount,
          dueDate: c.dueDate ?? null,
        })),
      },
    },
    include: {
      contributions: {
        include: { villa: { select: { id: true, villaNumber: true, ownerName: true } } },
      },
    },
  });
}
