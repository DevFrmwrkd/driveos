import { cronJobs } from "convex/server";
import { api } from "./_generated/api";

// ============================================================
// Scheduled maintenance
// ------------------------------------------------------------
// Keeps derived data fresh without manual intervention:
//   - duplicate detection re-clusters newly indexed files
//   - recommendations regenerate from the latest state
//   - the alerts feed is recomputed from the live storage state
// ============================================================

const crons = cronJobs();

// Re-cluster duplicates hourly.
crons.interval("detect duplicates", { hours: 1 }, api.duplicates.runDuplicateDetection, {});

// Regenerate cleanup recommendations a few minutes later so they
// reflect the freshly detected duplicate clusters.
crons.interval("generate recommendations", { hours: 1 }, api.recommendations.generateRecommendations, {});

// Recompute the notifications / alerts feed every 15 minutes.
crons.interval("refresh alerts", { minutes: 15 }, api.notifications.refresh, {});

export default crons;
