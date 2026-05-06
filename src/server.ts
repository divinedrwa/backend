import cron from "node-cron";
import { app } from "./app";
import { env } from "./config/env";
import { runBillingReminderJobs, syncAllBillingCycleStatuses } from "./modules/billing-cycle/services/cycle-service";

const host = process.env.HOST ?? "0.0.0.0";
app.listen(env.PORT, host, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://${host}:${env.PORT}`);
});

/** UTC hourly: persist cycle enum from windows + reminder notifications. */
cron.schedule(
  "0 * * * *",
  async () => {
    try {
      await syncAllBillingCycleStatuses();
      await runBillingReminderJobs();
    } catch (e) {
      console.error("[billing-cron]", e);
    }
  },
  { timezone: "Etc/UTC" }
);
