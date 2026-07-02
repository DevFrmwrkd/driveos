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

// How long after a scan completes before analysis fires. Long enough that all
// roots/passes of one agent sync cycle coalesce into a single run.
const ANALYSIS_DEBOUNCE_MS = 5 * 60 * 1000;
// Floor between analysis runs per tenant. Analysis pages the entire catalog,
// so its cost scales with catalog size, not with what changed — running it per
// scan session (10×/hour) was the single biggest bandwidth burner.
const ANALYSIS_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Emergency kill switch: the current analyzer cannot safely rebuild a
// 10-million-row catalog. It is off by default; explicitly set
// DRIVEOS_AUTO_ANALYSIS=true only after replacing it with incremental analysis.
const AUTO_ANALYSIS_ENABLED = process.env.DRIVEOS_AUTO_ANALYSIS === "true";

// Agent-only (internal): close a scan session and trigger per-tenant analysis.
export const complete = internalMutation({
  args: {
    sessionId: v.string(),
    status: v.string(), // "completed" | "failed" | "partial"
    errorsCount: v.number(),
    tenantId: v.optional(v.string()),
    // Delta-syncing agents (1.1+) upload only changed files, so per-batch
    // progress undercounts what was actually walked. They report true totals
    // here at the end; absent for older agents.
    filesSeen: v.optional(v.number()),
    bytesSeen: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("scanSessions", args.sessionId);
    if (!id) return;

    const session = await ctx.db.get(id);
    if (!session) return;

    const tenantId = session.tenantId || args.tenantId || "";
    const timestamp = Date.now();
    const filesScanned = args.filesSeen ?? session.filesScanned;
    const bytesScanned = args.bytesSeen ?? session.bytesScanned;
    await ctx.db.patch(id, {
      completedAt: timestamp,
      status: args.status,
      errorsCount: args.errorsCount,
      filesScanned,
      bytesScanned,
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
      message: `Completed scan session for ${session.rootPath} with status ${args.status}. Scanned ${filesScanned} files (${(bytesScanned / (1024 ** 4)).toFixed(2)} TB).`,
      createdAt: timestamp,
    });

    // Analysis is change-gated and debounced: it only arms when uploadBatch
    // recorded real inserts/changes (dirtyCount > 0), a single run is in flight
    // at a time (scheduled flag), and runs are at least a day apart. A cycle
    // of unchanged scans therefore schedules NOTHING.
    if (AUTO_ANALYSIS_ENABLED && (args.status === "completed" || args.status === "partial")) {
      const state = await ctx.db
        .query("analysisState")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
        .first();
      if (state && state.dirtyCount > 0 && !state.scheduled) {
        const earliestNextRun = state.lastRunAt + ANALYSIS_MIN_INTERVAL_MS;
        const delay = Math.max(ANALYSIS_DEBOUNCE_MS, earliestNextRun - timestamp);
        await ctx.db.patch(state._id, { scheduled: true });
        await ctx.scheduler.runAfter(delay, internal.scans.runPostScanAnalysis, {
          tenantId,
          scanSessionId: id,
          machineId: session.machineId,
        });
      }
    }
  },
});

// Atomically claim one analysis run. This check lives at execution time (not
// only scheduling time) so hundreds of jobs queued by an older deployment
// self-cancel after the first claimant instead of all scanning the catalog.
export const claimAnalysisRun = internalMutation({
  args: { tenantId: v.string() },
  handler: async (ctx, args) => {
    if (!AUTO_ANALYSIS_ENABLED) {
      return { shouldRun: false, claimedDirtyCount: 0 };
    }

    const state = await ctx.db
      .query("analysisState")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .first();
    if (!state || state.dirtyCount <= 0) {
      return { shouldRun: false, claimedDirtyCount: 0 };
    }

    const now = Date.now();
    if (state.lastRunAt + ANALYSIS_MIN_INTERVAL_MS > now) {
      return { shouldRun: false, claimedDirtyCount: 0 };
    }

    const claimedDirtyCount = state.dirtyCount;
    await ctx.db.patch(state._id, {
      scheduled: false,
      dirtyCount: 0,
      lastRunAt: now,
    });
    return { shouldRun: true, claimedDirtyCount };
  },
});

export const restoreAnalysisAfterFailure = internalMutation({
  args: { tenantId: v.string(), claimedDirtyCount: v.number() },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("analysisState")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .first();
    if (!state) return;

    const patch: { dirtyCount: number; scheduled?: boolean } = {
      dirtyCount: state.dirtyCount + args.claimedDirtyCount,
    };
    if (!state.scheduled) {
      patch.scheduled = true;
      const delay = Math.max(
        ANALYSIS_DEBOUNCE_MS,
        state.lastRunAt + ANALYSIS_MIN_INTERVAL_MS - Date.now()
      );
      await ctx.scheduler.runAfter(delay, internal.scans.runPostScanAnalysis, {
        tenantId: args.tenantId,
      });
    }
    await ctx.db.patch(state._id, patch);
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
    const claim = await ctx.runMutation(internal.scans.claimAnalysisRun, {
      tenantId: args.tenantId,
    });
    if (!claim.shouldRun) return { success: true };

    try {
      await ctx.runAction(internal.duplicates.runDuplicateDetection, { tenantId: args.tenantId });
      await ctx.runAction(internal.recommendations.generateRecommendations, { tenantId: args.tenantId });
      await ctx.runMutation(internal.scans.recordAnalysisComplete, {
        tenantId: args.tenantId,
        scanSessionId: args.scanSessionId,
        machineId: args.machineId,
      });
    } catch (err) {
      await ctx.runMutation(internal.scans.restoreAnalysisAfterFailure, {
        tenantId: args.tenantId,
        claimedDirtyCount: claim.claimedDirtyCount,
      });
      throw err;
    }
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
