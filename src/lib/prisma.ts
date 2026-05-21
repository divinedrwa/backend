import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

const logLevel = process.env.LOG_LEVEL ?? "info";

export const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "warn" },
    { emit: "event", level: "error" },
    ...(logLevel === "debug" ? [{ emit: "event" as const, level: "query" as const }] : []),
  ],
});

prisma.$on("warn", (e) => {
  logger.warn({ target: e.target, timestamp: e.timestamp }, e.message);
});

prisma.$on("error", (e) => {
  logger.error({ target: e.target, timestamp: e.timestamp }, e.message);
});

if (logLevel === "debug") {
  prisma.$on("query", (e) => {
    logger.debug(
      { query: e.query, params: e.params, duration: e.duration },
      "prisma query",
    );
  });
}
