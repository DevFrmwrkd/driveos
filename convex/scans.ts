import { v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("scanSessions").order("desc").take(50);
  },
});

export const start = mutation({
  args: {
    machineId: v.string(),
    driveId: v.optional(v.string()),
    rootPath: v.string(),
    agentVersion: v.string(),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const sessionId = await ctx.db.insert("scanSessions", {
      machineId: args.machineId,
      driveId: args.driveId,
      rootPath: args.rootPath,
      startedAt: timestamp,
      status: "running",
      filesScanned: 0,
      bytesScanned: 0,
      errorsCount: 0,
      agentVersion: args.agentVersion,
    });

    await ctx.db.insert("auditLogs", {
      machineId: args.machineId,
      action: "scan_start",
      entityType: "scanSession",
      entityId: sessionId,
      message: `Started scan session for path ${args.rootPath}`,
      createdAt: timestamp,
    });

    return sessionId;
  },
});

export const complete = mutation({
  args: {
    sessionId: v.string(),
    status: v.string(), // "completed" | "failed" | "partial"
    errorsCount: v.number(),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("scanSessions", args.sessionId);
    if (!id) return;

    const session = await ctx.db.get(id);
    if (!session) return;

    const timestamp = Date.now();
    await ctx.db.patch(id, {
      completedAt: timestamp,
      status: args.status,
      errorsCount: args.errorsCount,
    });

    // Update drive statistics after successful scan
    if (session.driveId) {
      const driveIdObj = ctx.db.normalizeId("drives", session.driveId);
      if (driveIdObj) {
        const drive = await ctx.db.get(driveIdObj);
        if (drive) {
          const currentScans = drive.scans || 0;
          await ctx.db.patch(driveIdObj, {
            status: "online",
            lastSeenAt: timestamp,
            scans: currentScans + 1,
          });
        }
      }
    }

    await ctx.db.insert("auditLogs", {
      machineId: session.machineId,
      action: "scan_complete",
      entityType: "scanSession",
      entityId: id,
      message: `Completed scan session for ${session.rootPath} with status ${args.status}. Scanned ${session.filesScanned} files (${(session.bytesScanned / (1024 ** 4)).toFixed(2)} TB).`,
      createdAt: timestamp,
    });

    // Auto-run analysis once per finished scan (not per file). A short delay lets
    // near-simultaneous multi-root completions coalesce onto fresh data, and runs
    // it off the critical path so completeScan returns immediately to the agent.
    if (args.status === "completed" || args.status === "partial") {
      await ctx.scheduler.runAfter(5000, api.scans.runPostScanAnalysis, {
        scanSessionId: id,
        machineId: session.machineId,
      });
    }
  },
});

// Post-scan analysis: rebuild duplicate clusters and regenerate recommendations
// from the now-current file catalog. Both are actions that page through the
// catalog (so they scale past per-transaction read limits) and are idempotent
// (they patch/replace existing clusters and clear open recommendations), so a
// re-run per scan session is safe and keeps Duplicates / Cleanup fresh.
export const runPostScanAnalysis = action({
  args: {
    scanSessionId: v.optional(v.string()),
    machineId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    await ctx.runAction(api.duplicates.runDuplicateDetection, {});
    await ctx.runAction(api.recommendations.generateRecommendations, {});
    await ctx.runMutation(internal.scans.recordAnalysisComplete, args);
    return { success: true };
  },
});

export const recordAnalysisComplete = internalMutation({
  args: {
    scanSessionId: v.optional(v.string()),
    machineId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLogs", {
      machineId: args.machineId,
      action: "analysis_complete",
      entityType: "scanSession",
      entityId: args.scanSessionId,
      message: "Auto-ran duplicate detection and recommendations after scan.",
      createdAt: Date.now(),
    });
  },
});
