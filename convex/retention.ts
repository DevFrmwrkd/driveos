import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// Telemetry tables grow forever without this: every scan session writes 2+
// audit logs and hourly sync cycles open ~10 sessions. Old rows have no
// product surface (the dashboard shows recent activity only), they just pad
// database storage.
const AUDIT_LOG_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SCAN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const BATCH_SIZE = 500;
// Upper bound per nightly run (MAX_BATCHES * BATCH_SIZE deletes per table) so
// a huge first-time backlog drains over a few nights instead of one giant run.
const MAX_BATCHES = 40;

// Delete up to one batch of docs older than the cutoff. Tables are scanned in
// _creationTime order (the default), so this only ever reads the oldest
// BATCH_SIZE docs — never the whole table.
export const purgeBatch = internalMutation({
  args: {
    table: v.union(v.literal("auditLogs"), v.literal("scanSessions")),
    cutoff: v.number(),
  },
  handler: async (ctx, args) => {
    const docs = await ctx.db.query(args.table).order("asc").take(BATCH_SIZE);
    let deleted = 0;
    for (const doc of docs) {
      if (doc._creationTime >= args.cutoff) break;
      await ctx.db.delete(doc._id);
      deleted++;
    }
    return deleted;
  },
});

export const purgeOldTelemetry = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const targets = [
      { table: "auditLogs" as const, cutoff: now - AUDIT_LOG_TTL_MS },
      { table: "scanSessions" as const, cutoff: now - SCAN_SESSION_TTL_MS },
    ];
    for (const target of targets) {
      for (let i = 0; i < MAX_BATCHES; i++) {
        const deleted: number = await ctx.runMutation(internal.retention.purgeBatch, target);
        // A short batch means everything older than the cutoff is gone.
        if (deleted < BATCH_SIZE) break;
      }
    }
  },
});
