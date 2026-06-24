import { v } from "convex/values";
import { internalAction, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember } from "./access";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("scanSessions")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(50);
  },
});

// Agent-only (internal): open a scan session in the agent's tenant.
export const start = internalMutation({
  args: {
    machineId: v.string(),
    driveId: v.optional(v.string()),
    rootPath: v.string(),
    agentVersion: v.string(),
    tenantId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const timestamp = Date.now();
    const sessionId = await ctx.db.insert("scanSessions", {
      tenantId,
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
      tenantId,
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

// Agent-only (internal): close a scan session and trigger per-tenant analysis.
export const complete = internalMutation({
  args: {
    sessionId: v.string(),
    status: v.string(), // "completed" | "failed" | "partial"
    errorsCount: v.number(),
    tenantId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("scanSessions", args.sessionId);
    if (!id) return;

    const session = await ctx.db.get(id);
    if (!session) return;

    const tenantId = session.tenantId || args.tenantId || "";
    const timestamp = Date.now();
    await ctx.db.patch(id, {
      completedAt: timestamp,
      status: args.status,
      errorsCount: args.errorsCount,
    });

    // Update drive statistics after successful scan (only this tenant's drive).
    if (session.driveId) {
      const driveIdObj = ctx.db.normalizeId("drives", session.driveId);
      if (driveIdObj) {
        const drive = await ctx.db.get(driveIdObj);
        if (drive && drive.tenantId === tenantId) {
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
      tenantId,
      machineId: session.machineId,
      action: "scan_complete",
      entityType: "scanSession",
      entityId: id,
      message: `Completed scan session for ${session.rootPath} with status ${args.status}. Scanned ${session.filesScanned} files (${(session.bytesScanned / (1024 ** 4)).toFixed(2)} TB).`,
      createdAt: timestamp,
    });

    // Auto-run analysis once per finished scan (not per file), scoped to this
    // tenant. A short delay lets near-simultaneous multi-root completions
    // coalesce onto fresh data and keeps completeScan off the critical path.
    if (args.status === "completed" || args.status === "partial") {
      await ctx.scheduler.runAfter(5000, internal.scans.runPostScanAnalysis, {
        tenantId,
        scanSessionId: id,
        machineId: session.machineId,
      });
    }
  },
});

// Post-scan analysis for a single tenant: rebuild duplicate clusters and
// regenerate recommendations from that tenant's now-current file catalog. Both
// are idempotent (patch/replace), so a re-run per scan session is safe.
export const runPostScanAnalysis = internalAction({
  args: {
    tenantId: v.string(),
    scanSessionId: v.optional(v.string()),
    machineId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    await ctx.runAction(internal.duplicates.runDuplicateDetection, { tenantId: args.tenantId });
    await ctx.runAction(internal.recommendations.generateRecommendations, { tenantId: args.tenantId });
    await ctx.runMutation(internal.scans.recordAnalysisComplete, {
      tenantId: args.tenantId,
      scanSessionId: args.scanSessionId,
      machineId: args.machineId,
    });
    return { success: true };
  },
});

export const recordAnalysisComplete = internalMutation({
  args: {
    tenantId: v.optional(v.string()),
    scanSessionId: v.optional(v.string()),
    machineId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auditLogs", {
      tenantId: args.tenantId || "",
      machineId: args.machineId,
      action: "analysis_complete",
      entityType: "scanSession",
      entityId: args.scanSessionId,
      message: "Auto-ran duplicate detection and recommendations after scan.",
      createdAt: Date.now(),
    });
  },
});
