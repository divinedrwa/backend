/**
 * Read-only gateway payment diagnosis for a merchant txn id (PhonePe) or Razorpay order id.
 *
 *   cd backend && npm run diagnose:gateway-payment -- --gateway phonepe --id pp202501abc
 *   cd backend && npm run diagnose:gateway-payment -- --gateway razorpay --id order_xxx
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { reconcilePhonePeFromPoll, reconcileRazorpayFromPoll } from "../src/modules/billing-cycle/gateway-payment-settle";
import { getPhonePeConfig, getEnvPhonePeConfig } from "../src/services/phonepe-billing";
import { getClientForSociety } from "../src/modules/billing-cycle/services/razorpay-billing";

const prisma = new PrismaClient();

function parseArgs(): { gateway: "phonepe" | "razorpay"; id: string } {
  const argv = process.argv.slice(2);
  let gateway: "phonepe" | "razorpay" | undefined;
  let id: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--gateway" && argv[i + 1]) {
      const g = argv[++i].toLowerCase();
      if (g === "phonepe" || g === "razorpay") gateway = g;
    } else if ((argv[i] === "--id" || argv[i] === "-i") && argv[i + 1]) {
      id = argv[++i];
    }
  }
  if (!gateway || !id) {
    console.error(
      "Usage: npm run diagnose:gateway-payment -- --gateway phonepe|razorpay --id <merchantTxnId|orderId>",
    );
    process.exit(1);
  }
  return { gateway, id };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const { gateway, id } = parseArgs();
  const apiBaseUrl = (process.env.API_BASE_URL ?? "(not set)").replace(/\/$/, "");

  console.log(`\n=== Gateway payment diagnosis ===`);
  console.log(`Gateway:     ${gateway}`);
  console.log(`Reference:   ${id}`);
  console.log(`API_BASE_URL: ${apiBaseUrl}`);
  console.log(`NODE_ENV:    ${process.env.NODE_ENV ?? "development"}\n`);

  try {
    const enumRows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'PaymentMode'
      ORDER BY e.enumsortorder
    `;
    const labels = enumRows.map((r) => r.enumlabel);
    console.log(`PaymentMode enum in DB: ${labels.join(", ") || "(none)"}`);
    if (!labels.includes("PHONEPE")) {
      console.log(
        "  ❌ PHONEPE missing — run: npm run prisma:migrate:deploy (fixes Internal server error on PhonePe settle)\n",
      );
    } else {
      console.log("");
    }
  } catch {
    console.log("(Could not read PaymentMode enum — not PostgreSQL or no access)\n");
  }

  const row = await prisma.userCyclePayment.findFirst({
    where: { paymentGatewayOrderId: id },
    include: {
      cycle: { select: { id: true, societyId: true, cycleKey: true } },
      user: { select: { id: true, email: true, username: true } },
    },
  });

  if (!row) {
    console.log("❌ No UserCyclePayment row with paymentGatewayOrderId = this id.");
    console.log("   The app may be polling the wrong id, or initiate never created the row.");
    process.exit(1);
  }

  const society = await prisma.society.findUnique({
    where: { id: row.cycle.societyId },
    select: { name: true },
  });

  console.log("Local row");
  console.log(`  society:     ${society?.name ?? row.cycle.societyId}`);
  console.log(`  user:        ${row.user?.email ?? row.userId}`);
  console.log(`  cycle:       ${row.cycle.cycleKey} (${row.cycleId})`);
  console.log(`  amountPaid:  ${row.amountPaid}`);
  console.log(`  status:      ${row.paymentStatus}`);
  console.log(`  gatewayPayId: ${row.paymentGatewayPaymentId ?? "(none)"}`);

  const logs = await prisma.billingPaymentLog.findMany({
    where: { cycleId: row.cycleId, userId: row.userId ?? undefined },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { status: true, createdAt: true, requestPayload: true, responsePayload: true },
  });

  console.log("\nRecent BillingPaymentLog (newest first)");
  for (const log of logs) {
    console.log(`  ${log.createdAt.toISOString()}  ${log.status}`);
  }

  if (gateway === "phonepe") {
    const dbCfg = await getPhonePeConfig(row.cycle.societyId);
    const envCfg = getEnvPhonePeConfig();
    console.log("\nPhonePe config");
    console.log(`  society row: ${dbCfg ? `yes (${dbCfg.environment}, merchant ${dbCfg.merchantId})` : "no — using env fallback"}`);
    console.log(`  env fallback: ${envCfg ? `yes (${envCfg.environment})` : "no"}`);
    if (!dbCfg && !envCfg) {
      console.log("  ❌ PhonePe not configured — status poll will return gateway_unavailable.");
    }
    if (
      process.env.NODE_ENV === "production" &&
      /localhost|127\.0\.0\.1/i.test(process.env.API_BASE_URL ?? "")
    ) {
      console.log("  ❌ API_BASE_URL is localhost in production — PhonePe cannot POST callbacks.");
    }
    console.log(`  expected callback: ${apiBaseUrl}/api/v1/payments/phonepe/callback`);
  } else {
    const client = await getClientForSociety(row.cycle.societyId);
    console.log("\nRazorpay config");
    console.log(`  client: ${client ? "configured" : "❌ not configured"}`);
    console.log(`  webhook: POST ${apiBaseUrl}/api/v1/payments/webhook`);
    console.log(`  RAZORPAY_WEBHOOK_SECRET: ${process.env.RAZORPAY_WEBHOOK_SECRET ? "set" : "missing"}`);
  }

  console.log("\nLive gateway poll + reconcile (same as mobile app)…\n");
  const poll =
    gateway === "phonepe"
      ? await reconcilePhonePeFromPoll(row.cycle.societyId, id)
      : await reconcileRazorpayFromPoll(row.cycle.societyId, id);

  console.log("Poll result");
  console.log(`  outcome:     ${poll.outcome}`);
  console.log(`  reconciled:  ${poll.reconciled}`);
  console.log(`  status:      ${poll.status ?? "(unchanged)"}`);
  console.log(`  rawState:    ${poll.gateway.rawState}`);
  console.log(`  rawCode:     ${poll.gateway.rawCode ?? "(none)"}`);
  console.log(`  reachable:   ${poll.gateway.gatewayReachable}`);
  if (poll.gateway.detail) console.log(`  detail:      ${poll.gateway.detail}`);

  const after = await prisma.userCyclePayment.findUnique({
    where: { id: row.id },
    select: { paymentStatus: true, paidAt: true },
  });
  console.log(`\nRow after poll: ${after?.paymentStatus}  paidAt=${after?.paidAt?.toISOString() ?? "null"}`);

  if (poll.outcome === "pending" || poll.outcome === "unknown") {
    console.log("\nLikely causes while still pending:");
    console.log("  • Payment not completed at gateway yet (sandbox delay).");
    console.log("  • Webhook/callback never reached server (check API_BASE_URL / Razorpay webhook URL).");
    console.log("  • Wrong PhonePe env (SANDBOX vs PRODUCTION) or merchant credentials mismatch.");
    console.log("  • See backend/docs/GATEWAY_PAYMENT_TROUBLESHOOTING.md");
  } else if (poll.outcome === "completed" || poll.outcome === "recorded") {
    console.log("\n✅ Server should now show SUCCESS — mobile poll should succeed on next Check again.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
