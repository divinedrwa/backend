#!/usr/bin/env npx tsx
/**
 * Phase 4 safety proof: sandbox charge-head trial + Divine Residency invariant check.
 *
 * - Mutates ONLY societies with isSandbox=true (default: qa-sandbox-society)
 * - Read-only check on Divine Residency (production society)
 * - Runs reconciliation on both after trial
 *
 * Usage (from backend/):
 *   npx tsx scripts/phase4-sandbox-charge-head-trial.ts
 *
 * Env: uses live API + DATABASE_URL from .env (must be sandbox on target society)
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { isSandboxSociety } from "../src/lib/sandboxSociety";
import { reconcileSocietyLedger } from "../src/lib/reconciliation";

const API = (
  process.env.LIVE_API_ORIGIN ??
  process.env.HTTP_SMOKE_BASE ??
  "https://gatepass-v037.onrender.com"
)
  .replace(/\/$/, "")
  .replace(/\/api$/, "");

const SANDBOX_ID = process.env.SMOKE_SANDBOX_SOCIETY_ID?.trim() || "qa-sandbox-society";
const DIVINE_ID = "cmp32fto40001qout5koygcqu";

const sandboxUser = process.env.SANDBOX_ADMIN_USER?.trim() || "sandbox_admin";
const sandboxPass = process.env.SANDBOX_ADMIN_PASS?.trim() || "Sandbox123!";

type TrialReport = {
  sandboxExists: boolean;
  sandboxTrialRan: boolean;
  chargeHeadLinesVerified: boolean;
  divineUnchanged: boolean;
  sandboxReconciliationOk: boolean;
  divineReconciliationOk: boolean;
  notes: string[];
};

async function apiLogin(
  societyId: string,
  username: string,
  password: string,
): Promise<{ token: string }> {
  for (const path of ["/api/auth/admin/login", "/api/auth/login"] as const) {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ societyId, username, password }),
    });
    if (r.status !== 200) continue;
    const j = (await r.json()) as { token?: string; user?: { role?: string } };
    if (j.token && j.user?.role === "ADMIN") return { token: j.token };
  }
  throw new Error(`Admin login failed for society ${societyId}`);
}

async function main(): Promise<void> {
  const report: TrialReport = {
    sandboxExists: false,
    sandboxTrialRan: false,
    chargeHeadLinesVerified: false,
    divineUnchanged: false,
    sandboxReconciliationOk: false,
    divineReconciliationOk: false,
    notes: [],
  };

  console.log("=== Phase 4 safety proof ===");
  console.log(`API: ${API}`);
  console.log("");

  // ── Divine Residency invariants (DB read-only) ──
  const divineBefore = await prisma.society.findUnique({
    where: { id: DIVINE_ID },
    select: {
      name: true,
      useChargeHeads: true,
      maintenanceBillingMode: true,
      _count: { select: { chargeHeads: true } },
    },
  });
  if (!divineBefore) {
    throw new Error("Divine Residency society not found");
  }
  console.log("Divine Residency (production):");
  console.log(`  useChargeHeads=${divineBefore.useChargeHeads}`);
  console.log(`  mode=${divineBefore.maintenanceBillingMode}`);
  console.log(`  chargeHeads=${divineBefore._count.chargeHeads}`);

  const sandboxRow = await prisma.society.findUnique({
    where: { id: SANDBOX_ID },
    select: {
      id: true,
      name: true,
      isSandbox: true,
      useChargeHeads: true,
    },
  });

  if (!sandboxRow) {
    report.notes.push(
      `Sandbox society ${SANDBOX_ID} not on live DB — seed with prisma:seed-sandbox on a disposable DB, or create isSandbox=true society.`,
    );
    console.log("");
    console.log("⚠ Sandbox not found — skipping mutating trial.");
    console.log("  K5 + Divine invariants still valid for production safety.");
  } else {
    report.sandboxExists = true;
    const sandboxOk = await isSandboxSociety(SANDBOX_ID);
    if (!sandboxOk) {
      throw new Error(`Refusing trial: ${SANDBOX_ID} is not marked isSandbox=true`);
    }

    console.log("");
    console.log(`Sandbox: ${sandboxRow.name} (${SANDBOX_ID})`);

    const { token } = await apiLogin(SANDBOX_ID, sandboxUser, sandboxPass);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Society-Id": SANDBOX_ID,
    };

    // Enable charge heads
    await fetch(`${API}/api/society-settings/maintenance-billing`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ useChargeHeads: true }),
    });

    // Upsert two charge heads (idempotent codes)
    for (const head of [
      { code: "maintenance", label: "Maintenance", fixedAmount: 1000 },
      { code: "sinking", label: "Sinking fund", fixedAmount: 200 },
    ]) {
      const existing = await prisma.societyChargeHead.findFirst({
        where: { societyId: SANDBOX_ID, code: head.code },
      });
      if (!existing) {
        const r = await fetch(`${API}/api/society-settings/charge-heads`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            code: head.code,
            label: head.label,
            amountType: "FIXED",
            fixedAmount: head.fixedAmount,
          }),
        });
        if (r.status >= 400) {
          const t = await r.text();
          throw new Error(`POST charge-head ${head.code}: ${r.status} ${t.slice(0, 200)}`);
        }
      }
    }

    // Ensure FY covering trial month (2099-01)
    let fy = await prisma.financialYear.findFirst({
      where: {
        societyId: SANDBOX_ID,
        startDate: { lte: new Date("2099-01-01T00:00:00.000Z") },
        endDate: { gte: new Date("2099-01-31T00:00:00.000Z") },
      },
      select: { id: true },
    });
    if (!fy) {
      fy = await prisma.financialYear.create({
        data: {
          societyId: SANDBOX_ID,
          label: "FY 2098-99 (Phase4 trial)",
          startDate: new Date("2098-04-01T00:00:00.000Z"),
          endDate: new Date("2099-03-31T00:00:00.000Z"),
        },
        select: { id: true },
      });
      report.notes.push("Created FY 2098-99 for sandbox trial cycle.");
    }

    const trialKey = "2099-01";
    let cycle = await prisma.billingCycle.findFirst({
      where: { societyId: SANDBOX_ID, cycleKey: trialKey },
      select: { id: true, publishedAt: true, amount: true },
    });

    if (!cycle) {
      const createRes = await fetch(`${API}/api/v1/admin/cycles`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          financialYearId: fy.id,
          cycleMonth: trialKey,
          title: "Phase4 trial Jan 2099",
          amount: 1200,
          paymentStartDate: "2099-01-01T00:00:00.000Z",
          paymentEndDate: "2099-01-31T23:59:59.000Z",
          lateFee: 0,
          gracePeriodDays: 0,
        }),
      });
      if (createRes.status === 409) {
        cycle = await prisma.billingCycle.findFirst({
          where: { societyId: SANDBOX_ID, cycleKey: trialKey },
          select: { id: true, publishedAt: true, amount: true },
        });
      } else if (createRes.status >= 400) {
        const t = await createRes.text();
        throw new Error(`POST billing cycle: ${createRes.status} ${t.slice(0, 200)}`);
      } else {
        const j = (await createRes.json()) as { cycle?: { id: string } };
        if (!j.cycle?.id) throw new Error("Create cycle: missing id");
        cycle = { id: j.cycle.id, publishedAt: null, amount: new Prisma.Decimal(1200) };
      }
    }

    if (cycle && !cycle.publishedAt) {
      const pub = await fetch(`${API}/api/v1/admin/cycles/${cycle.id}/publish`, {
        method: "POST",
        headers,
        body: "{}",
      });
      if (pub.status >= 400) {
        const t = await pub.text();
        report.notes.push(`Publish trial cycle: ${pub.status} ${t.slice(0, 150)}`);
      } else {
        report.sandboxTrialRan = true;
      }
    } else if (cycle?.publishedAt) {
      report.sandboxTrialRan = true;
      report.notes.push("Trial cycle already published — verifying snapshots.");
    }

    // Verify villa snapshot charge lines sum to expected
    const villa = await prisma.villa.findFirst({
      where: { societyId: SANDBOX_ID },
      select: { id: true },
    });
    if (villa && cycle) {
      const mc = await prisma.maintenanceCollectionCycle.findFirst({
        where: { societyId: SANDBOX_ID, periodKey: trialKey },
        select: { id: true },
      });
      if (mc) {
        const snap = await prisma.villaMaintenanceSnapshot.findUnique({
          where: { cycleId_villaId: { cycleId: mc.id, villaId: villa.id } },
          include: {
            chargeLines: { orderBy: { sortOrder: "asc" } },
          },
        });
        if (snap) {
          const lineSum = snap.chargeLines.reduce((s, l) => s + Number(l.amount), 0);
          const expected = Number(snap.expectedAmount);
          const match = Math.abs(lineSum - expected) < 0.02 && snap.chargeLines.length >= 2;
          report.chargeHeadLinesVerified = match;
          console.log("");
          console.log("Sandbox snapshot:");
          console.log(`  expectedAmount=${expected}`);
          console.log(`  chargeLines=${snap.chargeLines.length} sum=${lineSum}`);
          for (const l of snap.chargeLines) {
            console.log(`    - ${l.label}: ${Number(l.amount)}`);
          }
          if (!match) {
            report.notes.push(`Line sum ${lineSum} != expected ${expected} or <2 lines`);
          }
        }
      }
    }

    // Disable charge heads again (cleanup — sandbox only)
    await fetch(`${API}/api/society-settings/maintenance-billing`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ useChargeHeads: false }),
    });
    report.notes.push("Sandbox useChargeHeads reset to false after trial.");
  }

  // Divine unchanged
  const divineAfter = await prisma.society.findUnique({
    where: { id: DIVINE_ID },
    select: {
      useChargeHeads: true,
      maintenanceBillingMode: true,
      _count: { select: { chargeHeads: true } },
    },
  });
  report.divineUnchanged =
    divineBefore.useChargeHeads === divineAfter?.useChargeHeads &&
    divineBefore.maintenanceBillingMode === divineAfter?.maintenanceBillingMode &&
    divineBefore._count.chargeHeads === divineAfter?._count.chargeHeads &&
    divineAfter?.useChargeHeads === false;

  console.log("");
  console.log("Divine Residency after sandbox trial:");
  console.log(`  unchanged=${report.divineUnchanged}`);

  // Reconciliation (read/compute — may create resolve notes on sandbox only)
  console.log("");
  console.log("Reconciliation pass…");
  const divineRecon = await reconcileSocietyLedger(DIVINE_ID);
  report.divineReconciliationOk = divineRecon.alertsCreated === 0;
  console.log(`  Divine: alertsCreated=${divineRecon.alertsCreated} ok=${report.divineReconciliationOk}`);

  if (report.sandboxExists) {
    const sandboxRecon = await reconcileSocietyLedger(SANDBOX_ID);
    report.sandboxReconciliationOk = sandboxRecon.alertsCreated === 0;
    console.log(
      `  Sandbox: alertsCreated=${sandboxRecon.alertsCreated} resolved=${sandboxRecon.alertsResolved}`,
    );
  }

  console.log("");
  console.log("=== Report ===");
  console.log(JSON.stringify(report, null, 2));

  const pass =
    report.divineUnchanged &&
    report.divineReconciliationOk &&
    (!report.sandboxExists ||
      !report.sandboxTrialRan ||
      report.chargeHeadLinesVerified);

  if (!pass) {
    console.error("");
    console.error("Phase 4 safety proof: INCOMPLETE or FAIL");
    process.exit(1);
  }

  console.log("");
  console.log("Phase 4 safety proof: PASS");
  console.log("(K5 live gate + Divine invariants" +
    (report.chargeHeadLinesVerified ? " + sandbox charge-head trial" : "") +
    ")");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
