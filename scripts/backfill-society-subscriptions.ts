/**
 * One-time backfill: SocietySubscription rows for societies created before the subscription migration.
 * Grandfathers existing tenants as ACTIVE (no trial expiry). Skips archived societies.
 *
 * Usage: cd backend && npx tsx scripts/backfill-society-subscriptions.ts
 */
import { SocietySubscriptionPlan, SocietySubscriptionStatus } from "@prisma/client";
import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  const societies = await prisma.society.findMany({
    where: { archivedAt: null, subscription: null },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (societies.length === 0) {
    console.log("No societies need subscription backfill.");
    return;
  }

  let created = 0;
  for (const s of societies) {
    await prisma.societySubscription.create({
      data: {
        societyId: s.id,
        plan: SocietySubscriptionPlan.STARTER,
        status: SocietySubscriptionStatus.ACTIVE,
        trialEndsAt: null,
        currentPeriodEnd: null,
        notes: "Auto-backfilled for pre-subscription tenant",
      },
    });
    created += 1;
    console.log(`  + ${s.name} (${s.id})`);
  }

  console.log(`Backfilled ${created} subscription(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
