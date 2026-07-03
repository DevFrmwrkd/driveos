import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Nightly retention sweep: drop auditLogs older than 90 days and scanSessions
// older than 30 days (batched, oldest-first). Keeps telemetry tables from
// padding database storage forever.
crons.daily(
  "purge old telemetry",
  { hourUTC: 3, minuteUTC: 30 },
  internal.retention.purgeOldTelemetry,
  {}
);

export default crons;
