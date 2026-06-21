import type { SmokeContext, SmokeIds } from "./types";
import { authedGet, extractList, firstId } from "./http";

/** Populate dynamic `:id` placeholders from list endpoints. */
export async function prefetchIds(ctx: SmokeContext): Promise<SmokeIds> {
  const ids: SmokeIds = {};
  const { baseUrl, societyId, tokens } = ctx;

  const tasks: Array<Promise<void>> = [];

  if (tokens.guard) {
    tasks.push(
      (async () => {
        const villas = await authedGet<unknown>(baseUrl, "/villas", tokens.guard!, societyId);
        ids.villaId = firstId(extractList(villas, ["villas", "items"]), ["id"]);
      })(),
    );
  }

  if (tokens.admin) {
    tasks.push(
      (async () => {
        const villas = await authedGet<unknown>(baseUrl, "/villas", tokens.admin!, societyId);
        ids.villaId ??= firstId(extractList(villas, ["villas", "items"]), ["id"]);
      })(),
    );
  }

  if (tokens.resident) {
    const t = tokens.resident;
    tasks.push(
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/residents/visitor-approval-requests", t, societyId);
        ids.visitorId = firstId(extractList(data, ["requests", "items", "visitors"]), ["id", "visitorId"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/residents/my-parcels", t, societyId);
        ids.parcelId = firstId(extractList(data, ["parcels", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/residents/my-polls", t, societyId);
        ids.pollId = firstId(extractList(data, ["polls", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/residents/society-expenses", t, societyId);
        ids.expenseId = firstId(extractList(data, ["expenses", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/residents/special-projects", t, societyId);
        ids.specialProjectId = firstId(extractList(data, ["projects", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/v1/financial-years", t, societyId);
        const years = extractList(data, ["financialYears", "years", "items"]);
        ids.financialYearId = firstId(years, ["id"]);
        const cycle = years[0] as Record<string, unknown> | undefined;
        if (cycle?.currentBillingCycleId && typeof cycle.currentBillingCycleId === "string") {
          ids.billingCycleId = cycle.currentBillingCycleId;
        }
      })(),
    );
  }

  if (tokens.admin) {
    const t = tokens.admin;
    tasks.push(
      (async () => {
        if (!ids.financialYearId) {
          const data = await authedGet<unknown>(baseUrl, "/v1/financial-years", t, societyId);
          ids.financialYearId = firstId(extractList(data, ["financialYears", "years", "items"]), ["id"]);
        }
        if (ids.financialYearId && !ids.billingCycleId) {
          const data = await authedGet<unknown>(
            baseUrl,
            `/v1/billing-cycles?financialYearId=${ids.financialYearId}`,
            t,
            societyId,
          );
          ids.billingCycleId = firstId(extractList(data, ["billingCycles", "cycles", "items"]), ["id"]);
        }
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/gates", t, societyId);
        ids.gateId = firstId(extractList(data, ["gates", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/polls", t, societyId);
        ids.pollAdminId = firstId(extractList(data, ["polls", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/guard-shifts", t, societyId);
        ids.guardShiftId = firstId(extractList(data, ["shifts", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/special-projects", t, societyId);
        ids.specialProjectId ??= firstId(extractList(data, ["projects", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/bank-accounts", t, societyId);
        ids.bankAccountId = firstId(extractList(data, ["accounts", "bankAccounts", "items"]), ["id"]);
      })(),
    );
  }

  if (tokens.guard) {
    tasks.push(
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/guards/my-parcels", tokens.guard!, societyId);
        ids.parcelId ??= firstId(extractList(data, ["parcels", "items"]), ["id"]);
      })(),
      (async () => {
        const data = await authedGet<unknown>(baseUrl, "/incidents", tokens.guard!, societyId);
        ids.incidentId = firstId(extractList(data, ["incidents", "items"]), ["id"]);
      })(),
    );
  }

  await Promise.all(tasks);
  return ids;
}
