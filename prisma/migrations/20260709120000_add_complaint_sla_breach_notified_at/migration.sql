-- Track one-time SLA breach alerts so hourly cron does not spam admins.
ALTER TABLE "Complaint" ADD COLUMN "slaBreachNotifiedAt" TIMESTAMP(3);
