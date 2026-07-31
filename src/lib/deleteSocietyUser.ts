import { Prisma, PrismaClient, UserRole } from "@prisma/client";

export class UserDeleteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserDeleteBlockedError";
  }
}

type Tx = Prisma.TransactionClient;

async function countBlockingRelations(tx: Tx, userId: string): Promise<string[]> {
  const [
    staffAttendance,
    vendorContracts,
    meetings,
    specialProjects,
    projectPayments,
    projectExpenses,
    billingLateFeeWaivers,
  ] = await Promise.all([
    tx.staffAttendance.count({ where: { markedById: userId } }),
    tx.vendorContract.count({ where: { createdById: userId } }),
    tx.meeting.count({ where: { createdById: userId } }),
    tx.specialProject.count({ where: { createdById: userId } }),
    tx.projectPayment.count({ where: { markedById: userId } }),
    tx.projectExpense.count({ where: { createdById: userId } }),
    tx.billingLateFeeWaiver.count({ where: { userId } }),
  ]);

  const blockers: string[] = [];
  if (staffAttendance > 0) blockers.push("staff attendance records");
  if (vendorContracts > 0) blockers.push("vendor contracts");
  if (meetings > 0) blockers.push("meetings");
  if (specialProjects > 0) blockers.push("special projects");
  if (projectPayments > 0) blockers.push("project payments");
  if (projectExpenses > 0) blockers.push("project expenses");
  if (billingLateFeeWaivers > 0) blockers.push("billing late-fee waivers");
  return blockers;
}

/**
 * Hard-delete a society user after clearing gate assignment and checking for
 * relations that still use ON DELETE RESTRICT.
 */
export async function deleteSocietyUser(
  prisma: PrismaClient,
  params: { userId: string; societyId: string },
): Promise<{ name: string; username: string; role: UserRole } | null> {
  const existing = await prisma.user.findFirst({
    where: { id: params.userId, societyId: params.societyId },
    select: { id: true, name: true, username: true, role: true },
  });
  if (!existing) return null;

  const blockers = await countBlockingRelations(prisma, params.userId);
  if (blockers.length > 0) {
    throw new UserDeleteBlockedError(
      `Cannot delete this user because they are linked to ${blockers.join(", ")}. ` +
        "Deactivate the account instead (set inactive), or reassign those records first.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.gate.updateMany({
      where: { assignedGuardId: params.userId, societyId: params.societyId },
      data: { assignedGuardId: null },
    });
    await tx.user.delete({ where: { id: params.userId } });
  });

  return existing;
}
