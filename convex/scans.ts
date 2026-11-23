import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember, requireRole } from "./access";
import { analysisStateForTenant, canPublishAnalysis, catalogGeneration, catalogAnalysisIsCurrent,
  analysisFollowUpDelay, hasRequestedScanAnalysis, ownsAnalysisRun, ANALYSIS_MIN_INTERVAL_MS } from "./catalogAnalysis";

const configuredManualLimit = Number(process.env.DRIVEOS_MANUAL_ANALYSIS_MAX_FILES || 250000);
const MANUAL_ANALYSIS_MAX_FILES = Math.min(1000000, Math.max(1000,
  Number.isFinite(configuredManualLimit) ? Math.floor(configuredManualLimit) : 250000));
const MANUAL_ANALYSIS_COOLDOWN_MS = 5 * 60 * 1000;
const SCAN_ANALYSIS_DEBOUNCE_MS = 1000;
const AUTO_ANALYSIS_ENABLED = process.env.DRIVEOS_AUTO_ANALYSIS === "true";
// A canceled action can still finish its running code. Keep that owner fenced
// longer than Convex's maximum action duration before repairing an orphan.
const ANALYSIS_OWNER_GRACE_MS = 60 * 60 * 1000;

async function enqueueAnalysis(ctx: any, state: any, manual = false, context: any = {}, scan = false) {
  const analysisRunId = (state.analysisRunId ?? 0) + 1;
  // Explicit scans keep their intent during the tenant cooldown instead of
  // repeatedly reading the catalog or requiring another user request.
  const delay = scan ? Math.max(SCAN_ANALYSIS_DEBOUNCE_MS, state.lastRunAt + MANUAL_ANALYSIS_COOLDOWN_MS - Date.now())
    : manual ? 0 : analysisFollowUpDelay(state.lastRunAt, Date.now());
  const analysisFunctionId = await ctx.scheduler.runAfter(delay,
    manual ? internal.scans.runManualAnalysis : internal.scans.runPostScanAnalysis,
    { tenantId: state.tenantId, ...context, analysisRunId });
  await ctx.db.patch(state._id, { scheduled: true, analysisRunId, analysisFunctionId, analysisClaimed: false,
    analysisMode: scan ? "scan" : manual ? "manual" : "automatic", analysisStatus: "queued", analysisError: undefined });
}

async function releaseAnalysis(ctx: any, state: any, patch: any = {}, options: { scanFollowUp?: boolean; suppressAutomatic?: boolean } = {}) {
  if (state.analysisFunctionId) {
    const job = await ctx.db.system.get(state.analysisFunctionId);
    if (job?.state.kind === "pending") await ctx.scheduler.cancel(state.analysisFunctionId);
  }
  const next = { ...state, ...patch, scheduled: false, analysisFunctionId: undefined, analysisClaimed: false };
  await ctx.db.patch(state._id, { ...patch, scheduled: false, analysisFunctionId: undefined, analysisClaimed: false });
  if (options.scanFollowUp || (!options.suppressAutomatic && hasRequestedScanAnalysis(next)))
    await enqueueAnalysis(ctx, next, true, {}, true);
  else if (!options.suppressAutomatic && AUTO_ANALYSIS_ENABLED && next.dirtyCount > 0) await enqueueAnalysis(ctx, next);
}

// An explicit scan can share an in-flight analyzer. Only a current generation
// satisfies that intent; catalog churn gets one bounded follow-up, not a loop.
async function finishAnalysis(ctx: any, state: any, success: boolean, generation?: number, error?: string, patch: any = {}) {
  const current = success && canPublishAnalysis(state, generation);
  const requested = hasRequestedScanAnalysis(state);
  const completedAt = Date.now();
  const common = { ...patch, ...(current ? { dirtyCount: 0, analyzedGeneration: generation, analysisValidatedAt: completedAt } : {}),
    analysisStatus: current ? "completed" : success ? "stale" : "failed",
    analysisError: current ? undefined : success ? "The catalog changed during analysis. Run Scan & Analyze again to refresh the results." : error || "Analysis failed. Try analysis again.",
    analysisCompletedAt: completedAt };
  if (requested && success && !current && (state.scanAnalysisFollowUps ?? 0) > 0) {
    await releaseAnalysis(ctx, state, { ...common, scanAnalysisFollowUps: state.scanAnalysisFollowUps - 1 }, { scanFollowUp: true });
    return { current, followingUp: true };
  }
  await releaseAnalysis(ctx, state, { ...common,
    ...(requested ? { scanAnalysisResolvedVersion: state.scanAnalysisRequestVersion } : {}) },
  { suppressAutomatic: requested || state.analysisMode === "scan" });
  return { current, followingUp: false };
}

// A pending canceled/failed job must not leave the public manual action locked
// forever. Claimed owners remain fenced while their code can still be active.
async function recoverAnalysisOwner(ctx: any, state: any): Promise<{ state: any; active: boolean }> {
  if (!state?.scheduled) return { state, active: false };
  const job = state.analysisFunctionId ? await ctx.db.system.get(state.analysisFunctionId) : null;
  if (job?.state.kind === "pending" || job?.state.kind === "inProgress") {
    if (job.state.kind !== "pending" || AUTO_ANALYSIS_ENABLED || !job.name.endsWith(":runPostScanAnalysis"))
      return { state, active: true };
    await ctx.scheduler.cancel(state.analysisFunctionId);
  } else if (((job?.state.kind === "canceled" && state.analysisClaimed) ||
    (!job && (state.analysisClaimed || !state.analysisFunctionId))) &&
    state.lastRunAt + ANALYSIS_OWNER_GRACE_MS > Date.now()) {
    return { state, active: true };
  }
  const patch = { scheduled: false, analysisFunctionId: undefined, analysisClaimed: false,
    dirtyCount: !catalogAnalysisIsCurrent(state) ? Math.max(1, state.dirtyCount) : state.dirtyCount,
    analysisStatus: "failed" as const, analysisError: "The previous analysis worker stopped before it finished. Run analysis again.",
    ...(hasRequestedScanAnalysis(state) ? { scanAnalysisResolvedVersion: state.scanAnalysisRequestVersion } : {}) };
  await ctx.db.patch(state._id, patch);
  return { state: { ...state, ...patch }, active: false };
}

async function analysisStatusForState(ctx: any, state: any) {
  const current = catalogAnalysisIsCurrent(state);
  const job = state?.analysisFunctionId ? await ctx.db.system.get(state.analysisFunctionId) : null;
  const stopped = state?.scheduled && (job ? ["failed", "canceled", "success"].includes(job.state.kind)
    : state.analysisFunctionId || state.lastRunAt + ANALYSIS_OWNER_GRACE_MS <= Date.now());
  const status = stopped ? "failed" : state?.scheduled ? state.analysisClaimed ? "running" : "queued"
    : state?.analysisStatus === "completed" && !current ? "stale" : state?.analysisStatus ?? (current ? "idle" : "stale");
  return { status, catalogCurrent: current, lastRunAt: state?.lastRunAt || null,
    completedAt: state?.analysisCompletedAt ?? null,
    validatedAt: state?.analysisValidatedAt ?? null,
    error: stopped ? "The analysis worker stopped before it finished. Run analysis again."
      : state?.analysisError ?? (status === "stale" ? "The catalog has changed since the last analysis." : null),
    maxFiles: MANUAL_ANALYSIS_MAX_FILES };
}

// Explicit dashboard requests never enable the expensive automatic scanner.
// Bound the current in-memory analyzer while an incremental catalog analyzer
// is unavailable, and report that boundary instead of silently reading millions
// of documents or fabricating successful results.
export const requestAnalysis = mutation({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireRole(ctx, ["admin", "producer", "editor", "assistant_editor"]);
    const owner = await recoverAnalysisOwner(ctx, await analysisStateForTenant(ctx, tenantId));
    let state = owner.state;
    if (owner.active) return { scheduled: false, message: "Analysis is already queued or running." };
    if (state && state.lastRunAt + MANUAL_ANALYSIS_COOLDOWN_MS > Date.now())
      return { scheduled: false, message: "Analysis was run recently. Try again in five minutes." };
    const file = await ctx.db.query("files").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).first();
    if (!file) return { scheduled: false, message: "Scan a drive before running analysis." };
    if (!state) {
      const value = { tenantId, dirtyCount: 0, scheduled: false, lastRunAt: 0 };
      state = { ...value, _id: await ctx.db.insert("analysisState", value) };
    }
    await enqueueAnalysis(ctx, state, true);
    return { scheduled: true, message: `Duplicate and cleanup analysis queued (up to ${MANUAL_ANALYSIS_MAX_FILES.toLocaleString()} catalog files).` };
  },
});

// This is reached only through the authenticated agent HTTP route after an
// explicit scan/cycle succeeds. Background scans never call this endpoint.
export const requestScanAnalysis = internalMutation({
  args: { sessionId: v.string(), tenantId: v.optional(v.string()), machineId: v.string() },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const id = ctx.db.normalizeId("scanSessions", args.sessionId);
    const session = id ? await ctx.db.get(id) : null;
    if (!tenantId || !session || session.tenantId !== tenantId || session.machineId !== args.machineId)
      throw new ConvexError("Unknown scan session for this machine.");
    if (session.status !== "completed") throw new ConvexError("Analysis requires a successfully completed scan.");
    if (session.analysisRequested) {
      const previous = await analysisStatusForState(ctx, await analysisStateForTenant(ctx, tenantId));
      return { scheduled: false, status: previous.status, message: previous.status === "failed" || previous.status === "stale"
        ? previous.error || "The previous analysis did not finish. Run analysis again."
        : previous.status === "completed" ? "Analysis for this scan is already complete."
          : "Analysis was already requested for this scan." };
    }
    const owner = await recoverAnalysisOwner(ctx, await analysisStateForTenant(ctx, tenantId));
    let state = owner.state;
    if (!state) {
      const value = { tenantId, dirtyCount: 0, scheduled: false, lastRunAt: 0 };
      state = { ...value, _id: await ctx.db.insert("analysisState", value) };
    }
    const patch = { scanAnalysisRequestVersion: (state.scanAnalysisRequestVersion ?? 0) + 1,
      scanAnalysisFollowUps: 1, analysisError: undefined };
    await ctx.db.patch(session._id, { analysisRequested: true });
    // An unchanged scan can confirm recent results without running both full
    // catalog readers again. Preserve the actual worker timestamps so clients
    // can distinguish validation of cached results from a new analysis run.
    if (!owner.active && state.analysisStatus === "completed" && catalogAnalysisIsCurrent(state) &&
        state.analysisCompletedAt !== undefined && state.analysisCompletedAt + MANUAL_ANALYSIS_COOLDOWN_MS > Date.now()) {
      await ctx.db.patch(state._id, { ...patch, scanAnalysisResolvedVersion: patch.scanAnalysisRequestVersion,
        analysisValidatedAt: Date.now() });
      return { scheduled: false, status: "completed", message: "Scan completed. Recent analysis is current; results reused." };
    }
    await ctx.db.patch(state._id, patch);
    state = { ...state, ...patch };
    if (owner.active) {
      const job: any = state.analysisFunctionId ? await ctx.db.system.get(state.analysisFunctionId) : null;
      // A daily automatic timer must not make an explicit user request wait
      // until tomorrow. A claimed owner, however, remains strictly fenced.
      if (job?.state.kind === "pending" && !state.analysisClaimed && job.name.endsWith(":runPostScanAnalysis")) {
        await ctx.scheduler.cancel(state.analysisFunctionId);
        await enqueueAnalysis(ctx, state, true, {}, true);
        return { scheduled: true, status: "queued", message: "Scan completed. Duplicate and cleanup analysis queued." };
      }
      return { scheduled: false, status: (await analysisStatusForState(ctx, state)).status,
        message: "Scan completed. Analysis is already queued or running." };
    }
    await enqueueAnalysis(ctx, state, true, {}, true);
    return { scheduled: true, status: "queued", message: "Scan completed. Duplicate and cleanup analysis queued." };
  },
});

export const analysisStatus = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return analysisStatusForState(ctx, await analysisStateForTenant(ctx, tenantId));
  },
});

export const captureAnalysisGeneration = internalQuery({
  args: { tenantId: v.string(), analysisRunId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const state = await analysisStateForTenant(ctx, args.tenantId);
    return ownsAnalysisRun(state, args.analysisRunId) ? catalogGeneration(state) : null;
  },
});

export const claimManualAnalysisRun = internalMutation({
  args: { tenantId: v.string(), analysisRunId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const state = await analysisStateForTenant(ctx, args.tenantId);
    if (!ownsAnalysisRun(state, args.analysisRunId) || state.analysisClaimed) return null;
    await ctx.db.patch(state._id, { analysisClaimed: true, analysisStatus: "running", lastRunAt: Date.now() });
    return catalogGeneration(state);
  },
});

export const runManualAnalysis = internalAction({
  args: { tenantId: v.string(), analysisRunId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let generation: number | undefined;
    try {
      const captured = await ctx.runMutation(internal.scans.claimManualAnalysisRun, args);
      if (captured === null) return;
      generation = captured;
      await ctx.runAction(internal.duplicates.runDuplicateDetection, { tenantId: args.tenantId, maxFiles: MANUAL_ANALYSIS_MAX_FILES });
      await ctx.runAction(internal.recommendations.generateRecommendations, { tenantId: args.tenantId, maxFiles: MANUAL_ANALYSIS_MAX_FILES });
      await ctx.runMutation(internal.scans.finishManualAnalysis, { ...args, success: true, catalogGeneration: generation });
    } catch (error) {
      await ctx.runMutation(internal.scans.finishManualAnalysis, { ...args, success: false, error: String(error), catalogGeneration: generation });
      throw error;
    }
  },
});

export const finishManualAnalysis = internalMutation({
  args: { tenantId: v.string(), success: v.boolean(), error: v.optional(v.string()), catalogGeneration: v.optional(v.number()), analysisRunId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const state = await analysisStateForTenant(ctx, args.tenantId);
    if (!ownsAnalysisRun(state, args.analysisRunId)) return;
    const { current, followingUp } = await finishAnalysis(ctx, state, args.success, args.catalogGeneration, args.error);
    await ctx.db.insert("auditLogs", { tenantId: args.tenantId, action: args.success ? "analysis_complete" : "analysis_failed",
      entityType: "analysis", message: args.success
        ? current ? "Duplicate detection and cleanup analysis completed." : followingUp
          ? "The catalog changed during analysis; one bounded follow-up is queued."
          : "Analysis finished after the catalog changed; cached results remain hidden. Run analysis again."
        : `Analysis failed: ${args.error}`, createdAt: Date.now() });
  },
});

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
    if (!session || session.tenantId !== (args.tenantId || "")) throw new ConvexError("Unknown scan session.");

    const tenantId = args.tenantId || "";
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
      const owner = await recoverAnalysisOwner(ctx, await analysisStateForTenant(ctx, tenantId));
      if (owner.state?.dirtyCount > 0 && !owner.active) {
        await enqueueAnalysis(ctx, owner.state, false, { scanSessionId: id, machineId: session.machineId });
      }
    }
  },
});

// Atomically claim one analysis run. This check lives at execution time (not
// only scheduling time) so hundreds of jobs queued by an older deployment
// self-cancel after the first claimant instead of all scanning the catalog.
export const claimAnalysisRun = internalMutation({
  args: { tenantId: v.string(), analysisRunId: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const state = await analysisStateForTenant(ctx, args.tenantId);
    if (!state || state.analysisClaimed || (args.analysisRunId !== undefined
      ? !ownsAnalysisRun(state, args.analysisRunId)
      : state.analysisRunId !== undefined)) return { shouldRun: false, claimedDirtyCount: 0 };
    if (!AUTO_ANALYSIS_ENABLED) {
      if (state.scheduled) await releaseAnalysis(ctx, state);
      return { shouldRun: false, claimedDirtyCount: 0 };
    }
    if (state.dirtyCount <= 0) {
      if (state.scheduled) await releaseAnalysis(ctx, state);
      return { shouldRun: false, claimedDirtyCount: 0 };
    }

    const now = Date.now();
    if (state.lastRunAt + ANALYSIS_MIN_INTERVAL_MS > now) {
      // A legacy anonymous worker may be a duplicate of an action already in
      // progress. Wait out that owner before replacing its unknown schedule.
      if (args.analysisRunId === undefined && state.scheduled && state.lastRunAt + ANALYSIS_OWNER_GRACE_MS > now)
        return { shouldRun: false, claimedDirtyCount: 0 };
      await releaseAnalysis(ctx, state);
      return { shouldRun: false, claimedDirtyCount: 0 };
    }

    const claimedDirtyCount = state.dirtyCount;
    await ctx.db.patch(state._id, {
      // Keep manual requests out until this action finishes publishing both
      // datasets. Concurrent analyzers could overwrite a newer generation.
      scheduled: true,
      analysisRunId: state.analysisRunId ?? 1,
      analysisClaimed: true,
      analysisStatus: "running",
      dirtyCount: 0,
      lastRunAt: now,
    });
    return { shouldRun: true, claimedDirtyCount, catalogGeneration: catalogGeneration(state), analysisRunId: state.analysisRunId ?? 1 };
  },
});

export const restoreAnalysisAfterFailure = internalMutation({
  args: { tenantId: v.string(), claimedDirtyCount: v.number(), analysisRunId: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("analysisState")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .first();
    if (!state || !ownsAnalysisRun(state, args.analysisRunId)) return;
    await finishAnalysis(ctx, state, false, undefined, args.error, { dirtyCount: state.dirtyCount + args.claimedDirtyCount });
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
    analysisRunId: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ success: boolean }> => {
    const claim = await ctx.runMutation(internal.scans.claimAnalysisRun, {
      tenantId: args.tenantId,
      analysisRunId: args.analysisRunId,
    });
    if (!claim.shouldRun) return { success: true };

    try {
      await ctx.runAction(internal.duplicates.runDuplicateDetection, { tenantId: args.tenantId });
      await ctx.runAction(internal.recommendations.generateRecommendations, { tenantId: args.tenantId });
      await ctx.runMutation(internal.scans.recordAnalysisComplete, {
        tenantId: args.tenantId,
        scanSessionId: args.scanSessionId,
        machineId: args.machineId,
        catalogGeneration: claim.catalogGeneration,
        analysisRunId: claim.analysisRunId,
      });
    } catch (err) {
      await ctx.runMutation(internal.scans.restoreAnalysisAfterFailure, {
        tenantId: args.tenantId,
        claimedDirtyCount: claim.claimedDirtyCount,
        analysisRunId: claim.analysisRunId,
        error: String(err),
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
    catalogGeneration: v.optional(v.number()),
    analysisRunId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const state = await analysisStateForTenant(ctx, args.tenantId || "");
    if (!ownsAnalysisRun(state, args.analysisRunId)) return;
    const { current, followingUp } = await finishAnalysis(ctx, state, true, args.catalogGeneration);
    await ctx.db.insert("auditLogs", {
      tenantId: args.tenantId || "",
      machineId: args.machineId,
      action: "analysis_complete",
      entityType: "scanSession",
      entityId: args.scanSessionId,
      message: current ? "Auto-ran duplicate detection and recommendations after scan."
        : followingUp ? "The catalog changed during analysis; one bounded follow-up is queued."
          : "Catalog changed during automatic analysis; cached results remain hidden until analysis runs again.",
      createdAt: Date.now(),
    });
  },
});
