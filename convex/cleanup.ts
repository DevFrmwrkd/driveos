import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireMember, requireRole, inTenant } from "./access";
import { CLEANUP_RECOMMENDATION_TYPES, fileMachine, insertApprovedJob, MAX_JOB_FILES, protectedFile, quarantineMachine } from "./jobUtils";
import { workspaceSettings } from "./settings";
import { classifyFile } from "../packages/shared/src/index";
import { decideJobLease, jobAvailableToAgent, withoutClaimToken } from "./jobLease";
import { cleanupPathIdentity, KEEP_COPY_PROTOCOL, KEEP_COPY_REVIEW, keepCopyReservedIds, purgeItemMetadata, requiresKeepCopy, validKeepCopyProof } from "./keepCopy";

const EDITORS = ["admin", "producer", "editor", "assistant_editor"];
const ACTIVE_QUARANTINE = new Set(["quarantined", "pending_restore", "pending_purge"]);

export const listJobs = query({ args: {}, handler: async ctx => {
  const { tenantId } = await requireMember(ctx);
  const jobs = await ctx.db.query("cleanupJobs").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).order("desc").take(200);
  return jobs.map(withoutClaimToken);
}});

export const listQuarantine = query({ args: {}, handler: async ctx => {
  const { tenantId } = await requireMember(ctx);
  const items = await ctx.db.query("quarantineItems").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).collect();
  return items.filter(item => ACTIVE_QUARANTINE.has(item.status));
}});

export const previewFiles = query({ args: { fileIds: v.array(v.string()) }, handler: async (ctx, args) => {
  const { tenantId } = await requireMember(ctx);
  if (args.fileIds.length > 4000) throw new ConvexError("Preview supports up to 4,000 files.");
  const files = [];
  for (const fileId of new Set(args.fileIds)) {
    const id = ctx.db.normalizeId("files", fileId);
    const file = id ? inTenant(await ctx.db.get(id), tenantId) : null;
    if (file && !file.deletedAt) files.push({ ...file, protected: Boolean(protectedFile(file)) });
  }
  return files;
}});

// refreshAt only invalidates the subscription as wall time passes; the server
// clock remains authoritative for whether a rollback deadline has expired.
export const purgeableCount = query({ args: { refreshAt: v.optional(v.number()) }, handler: async ctx => {
  const { tenantId } = await requireMember(ctx);
  const items = await ctx.db.query("quarantineItems").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).collect();
  const expired = items.filter(i => i.status === "quarantined" && i.rollbackUntil <= Date.now());
  return { count: expired.length, bytes: expired.reduce((s, i) => s + i.sizeBytes, 0) };
}});

// Validate current catalog records, not caller-supplied byte counts or risk labels.
// A non-regenerable file is eligible only when an exact full-hash duplicate has
// a distinct, live keep copy. RAW/final/project/admin files remain protected.
async function validatedFiles(ctx: any, tenantId: string, ids: string[]) {
  if (!ids.length) throw new ConvexError("No files were selected for quarantine.");
  if (ids.length > 4000) throw new ConvexError("Select at most 4,000 files per cleanup request.");
  const settings = await workspaceSettings(ctx, tenantId);
  const projects = new Map<string, any>();
  const clusters = new Map<string, any>();
  const files = [];
  const selected = new Set(ids);
  const legacyReservedIds = new Set<string>();
  const reservedKeepIds = new Set<string>();
  const reservationJobs = new Map<string, any>();
  for (const status of ["approved", "queued", "running"]) {
    const active = await ctx.db.query("cleanupJobs").withIndex("by_tenant_status", (q: any) => q.eq("tenantId", tenantId).eq("status", status)).take(201);
    if (active.length > 200) throw new ConvexError("Wait for pending file operations to finish before starting another cleanup.");
    for (const job of active) {
      reservationJobs.set(String(job._id), job);
      if (job.action === "quarantine") for (const id of job.affectedFileIds) legacyReservedIds.add(id);
      for (const id of keepCopyReservedIds(job)) reservedKeepIds.add(id);
    }
    if (active.some((job: any) => job.action === "quarantine" && job.affectedFileIds.some((id: string) => selected.has(id))))
      throw new ConvexError("Some selected files are already queued for quarantine.");
  }
  if ([...selected].some(id => reservedKeepIds.has(id)))
    throw new ConvexError("A selected file is the keep copy for a pending cleanup. Wait for that operation to finish.");
  const reserved = async (file: any) => {
    if (legacyReservedIds.has(String(file._id)) || reservedKeepIds.has(String(file._id))) return true;
    if (!file.pendingCleanupJobId) return false;
    if (!reservationJobs.has(file.pendingCleanupJobId)) {
      const id = ctx.db.normalizeId("cleanupJobs", file.pendingCleanupJobId);
      reservationJobs.set(file.pendingCleanupJobId, id ? await ctx.db.get(id) : null);
    }
    const job = reservationJobs.get(file.pendingCleanupJobId);
    return Boolean(job?.tenantId === tenantId && job.action === "quarantine" &&
      ["approved", "queued", "running"].includes(job.status) && job.affectedFileIds.includes(String(file._id)));
  };
  for (const fileId of selected) {
    const id = ctx.db.normalizeId("files", fileId);
    const file = id ? await ctx.db.get(id) : null;
    if (!file || file.tenantId !== tenantId || file.deletedAt || file.source !== "local") {
      throw new ConvexError("A selected file is no longer available. Refresh the cleanup list.");
    }
    if (protectedFile(file)) throw new ConvexError(`Protected file cannot be quarantined: ${file.name}`);
    if (await reserved(file)) throw new ConvexError(`File is already reserved for cleanup: ${file.name}`);
    const machineId = await fileMachine(ctx, file, tenantId);
    let keepCopyProof: any;
    let rules = settings.cleanupRules;
    if (file.projectId) {
      if (!projects.has(file.projectId)) {
        const pid = ctx.db.normalizeId("projects", file.projectId);
        projects.set(file.projectId, pid ? await ctx.db.get(pid) : null);
      }
      const project = projects.get(file.projectId);
      if (project?.tenantId === tenantId && project.cleanupRules) {
        rules = { ...rules, proxyDelete: rules.proxyDelete && project.cleanupRules.proxyDelete,
          cacheDelete: rules.cacheDelete && project.cleanupRules.cacheDelete };
      }
    }
    const classification = classifyFile(file.path, file.name);
    const regenerable = ["CACHE", "RENDER_PREVIEW", "PROXY"].includes(classification);
    if ((["CACHE", "RENDER_PREVIEW"].includes(classification) && !rules.cacheDelete) ||
      (classification === "PROXY" && !rules.proxyDelete)) {
      throw new ConvexError(`Cleanup is disabled by the workspace/project rules for ${file.name}.`);
    }
    if (!regenerable) {
      if (!file.fullHash) throw new ConvexError(`A verified duplicate is required before cleaning ${file.name}.`);
      if (!clusters.has(file.fullHash)) clusters.set(file.fullHash,
        await ctx.db.query("duplicateClusters").withIndex("by_tenant_hashKey", (q: any) =>
          q.eq("tenantId", tenantId).eq("hashKey", file.fullHash)).first());
      const cluster = clusters.get(file.fullHash);
      const keepIds: string[] = cluster ? [cluster.recommendedKeepFileId, ...cluster.fileIds]
        .filter((keepId: string | undefined): keepId is string => Boolean(keepId) && keepId !== String(file._id) && !selected.has(keepId!)) : [];
      let keep: any = null;
      for (const keepId of new Set(keepIds)) {
        const candidateId = ctx.db.normalizeId("files", keepId);
        const candidate = candidateId ? await ctx.db.get(candidateId) : null;
        if (candidate?.tenantId === tenantId && candidate.source === "local" && !candidate.deletedAt &&
          candidate.fullHash === file.fullHash && candidate.sizeBytes === file.sizeBytes &&
          cleanupPathIdentity(candidate.path) !== cleanupPathIdentity(file.path) && !(await reserved(candidate))) {
          let keepMachineId: string;
          try { keepMachineId = await fileMachine(ctx, candidate, tenantId); } catch { continue; }
          if (keepMachineId !== machineId) continue;
          keep = candidate;
          break;
        }
      }
      if (!cluster || cluster.type !== "exact" || !cluster.fileIds.includes(String(file._id)) ||
        !keep || keep.tenantId !== tenantId || keep.deletedAt || selected.has(String(keep._id)) ||
        keep._id === file._id || keep.fullHash !== file.fullHash || keep.sizeBytes !== file.sizeBytes) {
        throw new ConvexError(`No separate verified keep copy is available for ${file.name}.`);
      }
      keepCopyProof = { fileId: String(file._id), keepFileId: String(keep._id), keepPath: keep.path,
        keepMachineId: machineId, fullHash: file.fullHash, sizeBytes: file.sizeBytes };
      if (!validKeepCopyProof(keepCopyProof, file, machineId))
        throw new ConvexError(`No separate verified keep copy is available for ${file.name}.`);
    }
    files.push({ ...file, machineId, ...(keepCopyProof ? { keepCopyProof } : {}) });
  }
  return files;
}

async function queueFiles(ctx: any, member: any, ids: string[], purgeAfter = false, recommendationId?: string,
  selectedRecommendationIds: string[] = recommendationId ? [recommendationId] : []) {
  if (purgeAfter && member.role !== "admin") throw new ConvexError("Only admins can permanently delete files.");
  const files = await validatedFiles(ctx, member.tenantId, ids);
  const groups = new Map<string, any[]>();
  for (const file of files) groups.set(file.machineId, [...(groups.get(file.machineId) ?? []), file]);
  const { retentionDays } = await workspaceSettings(ctx, member.tenantId);
  const jobIds = [];
  const jobProofs = new Map<string, any[]>();
  const clusterIds = new Set<string>();
  const visitedHashes = new Set<string>();
  for (const file of files) {
    if (!file.fullHash || visitedHashes.has(file.fullHash)) continue;
    visitedHashes.add(file.fullHash);
    const cluster = await ctx.db.query("duplicateClusters").withIndex("by_tenant_hashKey", (q: any) => q.eq("tenantId", member.tenantId).eq("hashKey", file.fullHash)).first();
    if (cluster && cluster.fileIds.some((id: string) => ids.includes(id))) {
      clusterIds.add(String(cluster._id));
      if (cluster.status === "open") await ctx.db.patch(cluster._id, { status: "queued", updatedAt: Date.now() });
    }
  }
  for (const [machineId, group] of groups) {
    const jobId = await insertApprovedJob(ctx, {
      tenantId: member.tenantId, machineId, requestedBy: member.email, action: "quarantine",
      fileIds: group.map(f => String(f._id)), bytes: group.reduce((s, f) => s + f.sizeBytes, 0),
      recommendationId, purgeAfter: purgeAfter || undefined,
      rollbackUntil: purgeAfter ? undefined : Date.now() + retentionDays * 86400000,
    });
    jobIds.push(jobId);
    jobProofs.set(String(jobId), group.flatMap(file => file.keepCopyProof ? [file.keepCopyProof] : []));
    for (const file of group) await ctx.db.patch(file._id, { pendingCleanupJobId: String(jobId) });
  }
  // The same file can appear in a cache recommendation and in Duplicate
  // Center. Remove reserved IDs from other open cleanup cards in this same
  // transaction so those cards cannot offer stale files while jobs are queued.
  const selectedSizes = new Map<string, number>(files.map(file => [String(file._id), file.sizeBytes]));
  const explicitlySelected = new Set(selectedRecommendationIds);
  const relatedRecommendationIds = new Set(selectedRecommendationIds);
  const openRecommendations = await ctx.db.query("recommendations")
    .withIndex("by_tenant_status", (q: any) => q.eq("tenantId", member.tenantId).eq("status", "open")).collect();
  for (const rec of openRecommendations) {
    if (!CLEANUP_RECOMMENDATION_TYPES.has(rec.type) || explicitlySelected.has(String(rec._id))) continue;
    const removed = rec.affectedFileIds.filter((id: string) => selectedSizes.has(id));
    if (!removed.length) continue;
    const remaining = rec.affectedFileIds.filter((id: string) => !selectedSizes.has(id));
    const removedBytes = [...new Set<string>(removed)].reduce((sum, id) => sum + selectedSizes.get(id)!, 0);
    await ctx.db.patch(rec._id, {
      affectedFileIds: remaining,
      affectedBytes: remaining.length ? Math.max(0, rec.affectedBytes - removedBytes) : 0,
      status: remaining.length ? "open" : "approved",
      updatedAt: Date.now(),
    });
    if (!remaining.length) relatedRecommendationIds.add(String(rec._id));
  }
  for (const jobId of jobIds) await ctx.db.patch(jobId, { result: {
    clusterIds: [...clusterIds], batchJobIds: jobIds, recommendationIds: [...relatedRecommendationIds],
    keepCopyProtocol: KEEP_COPY_PROTOCOL, keepCopyRequired: Boolean(jobProofs.get(String(jobId))?.length),
    keepCopyProofs: jobProofs.get(String(jobId)) ?? [],
  } });
  return { jobIds, queued: files.length, bytes: files.reduce((s, f) => s + f.sizeBytes, 0) };
}

export const queueQuarantine = mutation({
  args: { fileIds: v.array(v.string()), purgeAfter: v.optional(v.boolean()), clusterId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const member = await requireRole(ctx, EDITORS);
    let cluster: any = null;
    if (args.clusterId) {
      const cid = ctx.db.normalizeId("duplicateClusters", args.clusterId);
      cluster = cid ? inTenant(await ctx.db.get(cid), member.tenantId) : null;
      if (!cluster || cluster.type !== "exact" || cluster.status !== "open" || args.fileIds.some(id => !cluster.fileIds.includes(id)))
        throw new ConvexError("The selected files are not part of an available exact duplicate cluster.");
    }
    const queued = await queueFiles(ctx, member, args.fileIds, args.purgeAfter);
    if (cluster) {
      for (const jobId of queued.jobIds) {
        const id = ctx.db.normalizeId("cleanupJobs", jobId)!;
        const job = await ctx.db.get(id);
        await ctx.db.patch(jobId, { result: { ...job?.result, clusterId: String(cluster._id), batchJobIds: queued.jobIds } });
      }
      await ctx.db.patch(cluster._id, { status: "queued", updatedAt: Date.now() });
    }
    return queued;
  },
});

export const queueRecommendations = mutation({
  args: { recommendationIds: v.array(v.string()), purgeAfter: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const member = await requireRole(ctx, EDITORS);
    if (!args.recommendationIds.length || args.recommendationIds.length > 100) throw new ConvexError("Choose 1 to 100 recommendations.");
    const records = [];
    for (const recId of new Set(args.recommendationIds)) {
      const id = ctx.db.normalizeId("recommendations", recId);
      const rec = id ? inTenant(await ctx.db.get(id), member.tenantId) : null;
      if (!rec || rec.status !== "open" || !CLEANUP_RECOMMENDATION_TYPES.has(rec.type)) {
        throw new ConvexError("This recommendation cannot be used for file cleanup. Refresh the list.");
      }
      records.push(rec);
    }
    const ids = Array.from(new Set(records.flatMap(r => r.affectedFileIds)));
    const result = await queueFiles(ctx, member, ids, args.purgeAfter, records.length === 1 ? String(records[0]._id) : undefined,
      records.map(rec => String(rec._id)));
    // Store all related recommendations on every grouped job so final state can
    // be recomputed across machines instead of completing on the first agent.
    for (const jobId of result.jobIds) {
      const id = ctx.db.normalizeId("cleanupJobs", jobId)!;
      const job = await ctx.db.get(id);
      await ctx.db.patch(jobId, { result: { ...job?.result,
        recommendationIds: Array.from(new Set([...(job?.result?.recommendationIds ?? []), ...records.map(r => String(r._id))])),
        batchJobIds: result.jobIds } });
    }
    for (const rec of records) await ctx.db.patch(rec._id, { status: "approved", updatedAt: Date.now() });
    return result;
  },
});

// Backwards-compatible entry point for existing duplicate-center clients.
export const createJob = mutation({
  args: { recommendationId: v.optional(v.string()), machineId: v.optional(v.string()), requestedBy: v.string(),
    action: v.string(), affectedFileIds: v.array(v.string()), affectedBytes: v.number(),
    purgeAfter: v.optional(v.boolean()), result: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const member = await requireRole(ctx, EDITORS);
    if (args.action !== "quarantine") throw new ConvexError("Use the dedicated scan, restore, or project action.");
    if (args.recommendationId) {
      const rid = ctx.db.normalizeId("recommendations", args.recommendationId);
      const rec = rid ? inTenant(await ctx.db.get(rid), member.tenantId) : null;
      if (!rec || !CLEANUP_RECOMMENDATION_TYPES.has(rec.type) || args.affectedFileIds.some(id => !rec.affectedFileIds.includes(id)))
        throw new ConvexError("The recommendation does not authorize these files.");
    }
    const queued = await queueFiles(ctx, member, args.affectedFileIds, args.purgeAfter, args.recommendationId);
    return queued.jobIds[0];
  },
});

export const approveJob = mutation({ args: { jobId: v.string(), approvedBy: v.string() }, handler: async (ctx, args) => {
  const member = await requireRole(ctx, EDITORS);
  const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
  const job = id ? inTenant(await ctx.db.get(id), member.tenantId) : null;
  if (!job) throw new ConvexError("Unknown job.");
  if (job.status === "approved" || job.status === "queued") return;
  if (job.status !== "pending_approval" || !job.machineId) throw new ConvexError("This job cannot be approved. Create a new machine-targeted request.");
  let result = job.result;
  if (job.action === "quarantine") {
    const files = await validatedFiles(ctx, member.tenantId, job.affectedFileIds);
    if (files.some(file => file.machineId !== job.machineId)) throw new ConvexError("Create a separate cleanup request for each machine.");
    const proofs = files.flatMap(file => file.keepCopyProof ? [file.keepCopyProof] : []);
    result = { ...result, keepCopyProtocol: KEEP_COPY_PROTOCOL, keepCopyRequired: Boolean(proofs.length), keepCopyProofs: proofs };
  }
  await ctx.db.patch(job._id, { status: "approved", approvedBy: member.email, leaseRequired: true, result, updatedAt: Date.now() });
}});

async function queuePurge(ctx: any, member: any, items: any[]) {
  const groups = new Map<string, any[]>();
  for (const item of items) {
    const machineId = await quarantineMachine(ctx, item, member.tenantId);
    const entry = purgeItemMetadata(item);
    if (entry.requiresKeepCopy && !validKeepCopyProof(entry.keepCopyProof, entry, machineId))
      throw new ConvexError("A quarantined duplicate has no verified keep-copy proof. Restore and rescan it before permanent deletion.");
    if (!groups.has(machineId)) groups.set(machineId, []);
    groups.get(machineId)!.push(item);
  }
  const jobIds = [];
  for (const [machineId, group] of groups) {
    for (let offset = 0; offset < group.length; offset += MAX_JOB_FILES) {
      const chunk = group.slice(offset, offset + MAX_JOB_FILES);
      jobIds.push(await insertApprovedJob(ctx, {
        tenantId: member.tenantId, machineId, requestedBy: member.email, action: "purge",
        fileIds: chunk.map(i => i.fileId), bytes: chunk.reduce((s, i) => s + i.sizeBytes, 0),
        result: { keepCopyProtocol: KEEP_COPY_PROTOCOL, keepCopyRequired: chunk.some(item => purgeItemMetadata(item).requiresKeepCopy),
          purgeItems: chunk.map(purgeItemMetadata) },
      }));
    }
  }
  for (const item of items) await ctx.db.patch(item._id, { status: "pending_purge" });
  return { queued: items.length, jobIds, jobId: jobIds[0] };
}

export const purgeExpired = mutation({ args: { requestedBy: v.string() }, handler: async (ctx) => {
  const member = await requireRole(ctx, ["admin"]);
  const all = await ctx.db.query("quarantineItems").withIndex("by_tenant", q => q.eq("tenantId", member.tenantId)).collect();
  return queuePurge(ctx, member, all.filter(i => i.status === "quarantined" && i.rollbackUntil <= Date.now()));
}});

export const purgeItem = mutation({ args: { quarantineId: v.string(), requestedBy: v.string() }, handler: async (ctx, args) => {
  const member = await requireRole(ctx, ["admin"]);
  const id = ctx.db.normalizeId("quarantineItems", args.quarantineId);
  const item = id ? inTenant(await ctx.db.get(id), member.tenantId) : null;
  if (!item || item.status !== "quarantined") throw new ConvexError("This item is not available for deletion.");
  return queuePurge(ctx, member, [item]);
}});

async function queueRestoreJob(ctx: any, item: any, tenantId: string, machineId: string, requestedBy: string) {
  if (item.status === "pending_restore") {
    for (const status of ["approved", "queued", "running"]) {
      const existing = await ctx.db.query("cleanupJobs").withIndex("by_tenant_machine_status", (q: any) =>
        q.eq("tenantId", tenantId).eq("machineId", machineId).eq("status", status))
        .filter((q: any) => q.and(q.eq(q.field("action"), "restore"), q.eq(q.field("result.quarantineId"), String(item._id)))).first();
      if (existing) return { jobId: existing._id };
    }
    throw new ConvexError("A restoration is pending but its job is unavailable. Contact your workspace administrator.");
  }
  if (item.status !== "quarantined") throw new ConvexError("This item is not available for restoration.");
  const jobId = await insertApprovedJob(ctx, {
    tenantId, machineId, requestedBy, action: "restore",
    fileIds: [item.fileId], bytes: item.sizeBytes,
    result: { quarantineId: String(item._id), originalPath: item.originalPath, quarantinePath: item.quarantinePath },
  });
  await ctx.db.patch(item._id, { status: "pending_restore", machineId });
  return { jobId };
}
async function requestRestoreJob(ctx: any, quarantineId: string) {
  const member = await requireRole(ctx, EDITORS);
  const id = ctx.db.normalizeId("quarantineItems", quarantineId);
  const item = id ? inTenant(await ctx.db.get(id), member.tenantId) : null;
  if (!item) throw new ConvexError("This item is not available for restoration.");
  return queueRestoreJob(ctx, item, member.tenantId, await quarantineMachine(ctx, item, member.tenantId), member.email);
}
export const requestRestore = mutation({ args: { quarantineId: v.string() }, handler: (ctx, args) => requestRestoreJob(ctx, args.quarantineId) });
export const markQuarantineRestored = mutation({ args: { quarantineId: v.string() }, handler: (ctx, args) => requestRestoreJob(ctx, args.quarantineId) });

export const requestRestoreAgent = internalMutation({ args: { quarantineId: v.string(), tenantId: v.string(), machineId: v.string() }, handler: async (ctx, args) => {
  const id = ctx.db.normalizeId("quarantineItems", args.quarantineId);
  const item = id ? inTenant(await ctx.db.get(id), args.tenantId) : null;
  if (!item || await quarantineMachine(ctx, item, args.tenantId) !== args.machineId) throw new ConvexError("Unknown machine quarantine item.");
  return queueRestoreJob(ctx, item, args.tenantId, args.machineId, `machine:${args.machineId}`);
}});

// Older purge jobs only stored a quarantine id/path. Hydrate their effective
// authorization from the persisted item, never from the requesting agent.
async function jobKeepSafety(ctx: any, job: any, tenantId: string) {
  const files = [];
  let needed = false;
  let missing = false;
  let result = job.result;
  if (job.action === "quarantine") {
    for (const fid of job.affectedFileIds) {
      const id = ctx.db.normalizeId("files", fid);
      const file = id ? inTenant(await ctx.db.get(id), tenantId) : null;
      if (!file) { needed = true; missing = true; continue; }
      files.push(file);
      if (!requiresKeepCopy(file)) continue;
      needed = true;
      const proofs = Array.isArray(job.result?.keepCopyProofs) ? job.result.keepCopyProofs : [];
      const proof = proofs.find((entry: any) => entry?.fileId === String(file._id));
      if (job.result?.keepCopyProtocol !== KEEP_COPY_PROTOCOL || !validKeepCopyProof(proof, file, job.machineId)) missing = true;
    }
  } else if (job.action === "purge") {
    const items = [];
    const entries = Array.isArray(job.result?.purgeItems) ? job.result.purgeItems : [];
    if (!entries.length) missing = needed = true;
    for (const entry of entries) {
      const id = ctx.db.normalizeId("quarantineItems", entry.quarantineItemId);
      const item = id ? inTenant(await ctx.db.get(id), tenantId) : null;
      let machineId: string | undefined;
      if (item) { try { machineId = await quarantineMachine(ctx, item, tenantId); } catch { /* fail closed below */ } }
      if (!item || machineId !== job.machineId || item.quarantinePath !== entry.quarantinePath ||
        (["approved", "queued", "running"].includes(job.status) && item.status !== "pending_purge") ||
        !job.affectedFileIds.includes(item.fileId)) {
        needed = missing = true;
        items.push({ ...entry, requiresKeepCopy: true });
        continue;
      }
      const metadata = purgeItemMetadata(item);
      items.push(metadata);
      if (metadata.requiresKeepCopy) {
        needed = true;
        if (!validKeepCopyProof(metadata.keepCopyProof, metadata, job.machineId)) missing = true;
      }
    }
    result = { ...result, keepCopyProtocol: KEEP_COPY_PROTOCOL, keepCopyRequired: needed, purgeItems: items };
  } else {
    for (const fid of job.affectedFileIds) {
      const id = ctx.db.normalizeId("files", fid);
      const file = id ? inTenant(await ctx.db.get(id), tenantId) : null;
      if (file) files.push(file);
    }
  }
  return { files, result, needed, missing };
}

export const getJob = internalQuery({ args: { jobId: v.string(), tenantId: v.optional(v.string()), machineId: v.optional(v.string()), keepCopyProtocol: v.optional(v.number()) }, handler: async (ctx, args) => {
  const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
  const job = id ? inTenant(await ctx.db.get(id), args.tenantId || "") : null;
  if (!job || (args.machineId && job.machineId !== args.machineId)) return null;
  const safety = await jobKeepSafety(ctx, job, args.tenantId || "");
  if (safety.needed && args.keepCopyProtocol !== KEEP_COPY_PROTOCOL) return null;
  if (safety.missing && ["approved", "queued", "pending_approval", "draft"].includes(job.status)) return null;
  return { ...withoutClaimToken(job), result: safety.result, files: safety.files };
}});

export const getQuarantineItem = internalQuery({ args: { quarantineId: v.string(), tenantId: v.optional(v.string()), machineId: v.optional(v.string()) }, handler: async (ctx, args) => {
  const id = ctx.db.normalizeId("quarantineItems", args.quarantineId);
  const item = id ? inTenant(await ctx.db.get(id), args.tenantId || "") : null;
  if (!item || (args.machineId && await quarantineMachine(ctx, item, args.tenantId || "") !== args.machineId)) return null;
  return item;
}});

function jobFileCount(job: any) {
  return Math.max(job.affectedFileIds.length, job.action === "purge" ? (job.result?.purgeItems?.length ?? 0) : 0);
}

async function blockOversizedJob(ctx: any, job: any, reason: string) {
  await ctx.db.patch(job._id, { pollBlocked: true, pollBlockedReason: reason, updatedAt: Date.now() });
  await ctx.db.insert("auditLogs", {
    tenantId: job.tenantId, machineId: job.machineId, action: "job_recovery_required", entityType: "cleanupJob", entityId: String(job._id),
    message: reason === KEEP_COPY_REVIEW
      ? "Pending duplicate cleanup has no stored keep-copy proof and requires manual review before it can run."
      : reason === "oversized_purge_waiting_split"
      ? "Oversized pending purge will be split into bounded jobs by the next agent poll."
      : "Oversized file operation requires manual review; existing physical-operation journals must be preserved.",
    createdAt: Date.now(),
  });
}

function canSplitOversizedPurge(job: any) {
  return job.action === "purge" && ["approved", "queued"].includes(job.status) &&
    !job.claimToken && !job.attempts && job.affectedFileIds.length === job.result?.purgeItems?.length;
}

// Only never-started purges can change job identity safely. A started job's
// durable disk receipts belong to its original id and require manual recovery.
async function splitOversizedPurge(ctx: any, job: any) {
  const items = [];
  for (let index = 0; index < job.result.purgeItems.length; index++) {
    const entry = job.result.purgeItems[index];
    const id = ctx.db.normalizeId("quarantineItems", entry.quarantineItemId);
    const item = id ? inTenant(await ctx.db.get(id), job.tenantId) : null;
    if (!item || item.status !== "pending_purge" || item.fileId !== job.affectedFileIds[index] ||
        item.quarantinePath !== entry.quarantinePath || await quarantineMachine(ctx, item, job.tenantId) !== job.machineId) {
      await blockOversizedJob(ctx, job, "oversized_purge_requires_review");
      return false;
    }
    items.push(item);
  }
  // Cancelling the parent in this transaction also rejects a stale worker's
  // later claim. No existing file is confirmed moved or deleted by this repair.
  await ctx.db.patch(job._id, { status: "cancelled", pollBlocked: undefined, pollBlockedReason: undefined, updatedAt: Date.now() });
  const jobIds = [];
  for (let offset = 0; offset < items.length; offset += MAX_JOB_FILES) {
    const chunk = items.slice(offset, offset + MAX_JOB_FILES);
    jobIds.push(await insertApprovedJob(ctx, {
      tenantId: job.tenantId, machineId: job.machineId, requestedBy: job.requestedBy, approvedBy: job.approvedBy, action: "purge",
      fileIds: chunk.map(item => item.fileId), bytes: chunk.reduce((sum, item) => sum + item.sizeBytes, 0),
      result: { keepCopyProtocol: KEEP_COPY_PROTOCOL, keepCopyRequired: chunk.some(item => purgeItemMetadata(item).requiresKeepCopy),
        purgeItems: chunk.map(purgeItemMetadata), splitFromJobId: String(job._id) },
    }));
  }
  await ctx.db.patch(job._id, { result: { ...job.result, replacementJobIds: jobIds } });
  return true;
}

async function pollCandidates(ctx: any, tenantId: string, machineId: string, leaseProtocol: number | undefined, keepCopyProtocol: number | undefined, now: number) {
  const jobs = [];
  const pendingJobs = [];
  for (const status of ["approved", "queued"]) {
    let pending = ctx.db.query("cleanupJobs").withIndex("by_tenant_machine_status_poll", (q: any) =>
      q.eq("tenantId", tenantId).eq("machineId", machineId).eq("status", status).eq("pollBlockedReason", undefined));
    if (leaseProtocol !== 1) pending = pending.filter((q: any) =>
      q.and(q.neq(q.field("leaseRequired"), true), q.eq(q.field("claimToken"), undefined)));
    if (keepCopyProtocol !== KEEP_COPY_PROTOCOL) pending = pending.filter((q: any) => q.neq(q.field("result.keepCopyRequired"), true));
    pendingJobs.push(...await pending.take(4));
  }
  if (leaseProtocol === 1) {
    // Range-scope before the limit: old tokenless jobs and active long jobs
    // cannot hide an expired lease behind the first 200 running records.
    jobs.push(...await ctx.db.query("cleanupJobs").withIndex("by_tenant_machine_status_poll", (q: any) =>
      q.eq("tenantId", tenantId).eq("machineId", machineId).eq("status", "running").eq("pollBlockedReason", undefined)
        .gt("leaseExpiresAt", 0).lte("leaseExpiresAt", now))
      .filter((q: any) => q.neq(q.field("claimToken"), undefined)).take(4));
  }
  jobs.push(...pendingJobs.sort((a, b) => a.createdAt - b.createdAt));
  return jobs;
}

export const pollPendingJobs = internalMutation({ args: { machineId: v.string(), tenantId: v.optional(v.string()), leaseProtocol: v.optional(v.number()), keepCopyProtocol: v.optional(v.number()) }, handler: async (ctx, args) => {
  const tenantId = args.tenantId || "";
  const now = Date.now();
  let repairAttempted = false;
  // Bound repair writes to one parent per poll. Marking other oversized rows
  // lets indexed candidates progress while their repair waits for later polls.
  for (const status of ["approved", "queued"]) {
    const blocked = await ctx.db.query("cleanupJobs").withIndex("by_tenant_machine_status_poll", q =>
      q.eq("tenantId", tenantId).eq("machineId", args.machineId).eq("status", status)
        .eq("pollBlockedReason", "oversized_purge_waiting_split")).first();
    if (blocked) {
      repairAttempted = true;
      if (canSplitOversizedPurge(blocked)) await splitOversizedPurge(ctx, blocked);
      else await blockOversizedJob(ctx, blocked, "oversized_purge_requires_review");
      break;
    }
  }
  let jobs = await pollCandidates(ctx, tenantId, args.machineId, args.leaseProtocol, args.keepCopyProtocol, now);
  let inspected = 0;
  while (inspected < 16) {
    const oversized = jobs.filter(job => jobFileCount(job) > MAX_JOB_FILES);
    if (!oversized.length) break;
    for (const job of oversized) {
      if (inspected++ >= 16) break;
      if (!repairAttempted && canSplitOversizedPurge(job)) {
        repairAttempted = true;
        await splitOversizedPurge(ctx, job);
      } else {
        await blockOversizedJob(ctx, job, canSplitOversizedPurge(job)
          ? "oversized_purge_waiting_split" : "oversized_operation_requires_review");
      }
    }
    jobs = await pollCandidates(ctx, tenantId, args.machineId, args.leaseProtocol, args.keepCopyProtocol, now);
  }
  const result = [];
  let hydratedFiles = 0;
  for (const job of jobs.filter(j => jobAvailableToAgent(j, now, args.leaseProtocol))) {
    if (result.length >= 4) break;
    if (hydratedFiles + jobFileCount(job) > MAX_JOB_FILES) continue;
    const safety = await jobKeepSafety(ctx, job, tenantId);
    hydratedFiles += job.affectedFileIds.length;
    if (safety.missing && job.status !== "running") {
      await blockOversizedJob(ctx, job, KEEP_COPY_REVIEW);
      continue;
    }
    if (safety.needed && args.keepCopyProtocol !== KEEP_COPY_PROTOCOL) continue;
    result.push({ ...withoutClaimToken(job), result: safety.result, files: safety.files });
  }
  return result;
}});

async function finishRestore(ctx: any, item: any, tenantId: string) {
  if (!ACTIVE_QUARANTINE.has(item.status) || item.status === "pending_purge") throw new ConvexError("The quarantine item is not restorable.");
  const now = Date.now();
  await ctx.db.patch(item._id, { status: "restored", restoredAt: now });
  const fid = ctx.db.normalizeId("files", item.fileId);
  const file = fid ? inTenant(await ctx.db.get(fid), tenantId) : null;
  if (file) await ctx.db.patch(file._id, { deletedAt: undefined, lastSeenAt: now, observationRevision: (file.observationRevision ?? 0) + 1 });
  await ctx.db.insert("auditLogs", { tenantId, action: "quarantine_restore", entityType: "quarantineItem", entityId: item._id,
    message: `Restored quarantined file ${item.originalPath}`, createdAt: now });
}

export const markQuarantineRestoredAgent = internalMutation({ args: { quarantineId: v.string(), tenantId: v.optional(v.string()), machineId: v.optional(v.string()) }, handler: async (ctx, args) => {
  // Metadata-only confirmations cannot prove which execution attempt moved the
  // file. Updated agents request a restore and finish its fenced job instead.
  throw new ConvexError("Upgrade the agent and request a leased restore job before confirming a restoration.");
}});

export const updateJobStatus = internalMutation({ args: {
  jobId: v.string(), status: v.string(), result: v.optional(v.any()), tenantId: v.optional(v.string()), machineId: v.optional(v.string()),
  claimToken: v.optional(v.string()),
  keepCopyProtocol: v.optional(v.number()),
  quarantineFiles: v.optional(v.array(v.object({ fileId: v.string(), originalPath: v.string(), quarantinePath: v.string(), sizeBytes: v.number() }))),
}, handler: async (ctx, args) => {
  const tenantId = args.tenantId || "";
  const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
  const job = id ? inTenant(await ctx.db.get(id), tenantId) : null;
  if (!job || !job.machineId || (args.machineId && job.machineId !== args.machineId)) throw new ConvexError("Unknown machine job.");
  if (!["running", "completed", "failed"].includes(args.status)) throw new ConvexError("Invalid job status.");
  let safety: Awaited<ReturnType<typeof jobKeepSafety>> | undefined;
  if (args.status === "running" && !["completed", "failed", "cancelled"].includes(job.status) && ["quarantine", "purge"].includes(job.action)) {
    // New agents may recover already executed journal receipts from a running
    // legacy attempt. Their physical-operation guard still refuses fresh work
    // without proof. Unstarted legacy jobs require explicit human review.
    const upgradedOwner = args.keepCopyProtocol === KEEP_COPY_PROTOCOL && job.status === "running" &&
      Boolean(job.claimToken) && job.claimToken === args.claimToken;
    if (!upgradedOwner) {
      safety = await jobKeepSafety(ctx, job, tenantId);
      if (safety.needed && args.keepCopyProtocol !== KEEP_COPY_PROTOCOL)
        return { claimed: false, reason: "keep_copy_agent_upgrade_required", status: job.status };
      if (safety.missing && job.status !== "running")
        return { claimed: false, reason: KEEP_COPY_REVIEW, status: job.status };
    }
  }
  if (job.pollBlocked && args.status === "running" && (!job.claimToken || job.claimToken !== args.claimToken)) {
    return { claimed: false, reason: job.pollBlockedReason || "job_requires_review", status: job.status };
  }
  const now = Date.now();
  const lease = decideJobLease(job, args.status, args.claimToken, now);
  if (!lease.accepted) return { claimed: false, reason: lease.reason, status: job.status };
  if (lease.renewing) {
    // A heartbeat never changes the action's original inputs or writes audit spam.
    await ctx.db.patch(job._id, { ...lease.patch, ...(safety ? { result: safety.result } : {}), updatedAt: now });
    return { claimed: true, claimToken: lease.patch.claimToken, leaseExpiresAt: lease.patch.leaseExpiresAt };
  }
  const jobResult = safety?.result ?? job.result ?? {};
  const result = { ...jobResult, ...(args.result || {}) };
  // Execution reports cannot rewrite the authorization used by later retries
  // or chained purges.
  for (const key of ["keepCopyProtocol", "keepCopyRequired", "keepCopyProofs", "purgeItems"])
    if (key in jobResult) result[key] = jobResult[key]; else delete result[key];
  const terminal = args.status === "completed" || args.status === "failed";
  if (job.action === "quarantine" && terminal && args.quarantineFiles?.length) {
    const createdItems = [];
    for (const qf of args.quarantineFiles) {
      if (!job.affectedFileIds.includes(qf.fileId)) throw new ConvexError("Unexpected quarantine file.");
      const fid = ctx.db.normalizeId("files", qf.fileId);
      const file = fid ? inTenant(await ctx.db.get(fid), tenantId) : null;
      if (!file || protectedFile(file) || file.path !== qf.originalPath || await fileMachine(ctx, file, tenantId) !== job.machineId)
        throw new ConvexError("Quarantine confirmation does not match the requested file.");
      if (file.deletedAt) continue;
      const required = requiresKeepCopy(file);
      const proofs = Array.isArray(job.result?.keepCopyProofs) ? job.result.keepCopyProofs : [];
      const proposedProof = proofs.find((proof: any) => proof?.fileId === qf.fileId);
      const keepCopyProof = validKeepCopyProof(proposedProof, file, job.machineId) ? proposedProof : undefined;
      const itemData = {
        tenantId, machineId: job.machineId, cleanupJobId: String(job._id), fileId: qf.fileId,
        originalPath: qf.originalPath, quarantinePath: qf.quarantinePath, sizeBytes: file.sizeBytes,
        movedAt: now, rollbackUntil: job.purgeAfter ? now : job.rollbackUntil ?? now + (await workspaceSettings(ctx, tenantId)).retentionDays * 86400000,
        status: "quarantined", requiresKeepCopy: required, ...(keepCopyProof ? { keepCopyProof } : {}),
      };
      const qid = await ctx.db.insert("quarantineItems", itemData);
      createdItems.push(purgeItemMetadata({ ...itemData, _id: qid }));
      await ctx.db.patch(file._id, { deletedAt: now, pendingCleanupJobId: undefined });
      if (file.fullHash) {
        const cluster = await ctx.db.query("duplicateClusters").withIndex("by_tenant_hashKey", q => q.eq("tenantId", tenantId).eq("hashKey", file.fullHash!)).first();
        if (cluster?.fileIds.includes(qf.fileId)) {
          const remaining = cluster.fileIds.filter(id => id !== qf.fileId);
          const perFileBytes = cluster.fileCount ? cluster.totalBytes / cluster.fileCount : file.sizeBytes;
          await ctx.db.patch(cluster._id, { fileIds: remaining, fileCount: remaining.length,
            totalBytes: perFileBytes * remaining.length, wastedBytes: perFileBytes * Math.max(0, remaining.length - 1),
            recommendedKeepFileId: remaining.includes(cluster.recommendedKeepFileId ?? "") ? cluster.recommendedKeepFileId : remaining[0],
            status: remaining.length < 2 ? "resolved" : cluster.status, updatedAt: now });
        }
      }
    }
    if (job.purgeAfter && createdItems.length) {
      if (createdItems.some(item => item.requiresKeepCopy && !validKeepCopyProof(item.keepCopyProof, item, job.machineId!))) {
        result.purgeBlockedReason = KEEP_COPY_REVIEW;
      } else {
        await insertApprovedJob(ctx, { tenantId, machineId: job.machineId, requestedBy: job.requestedBy, action: "purge",
          fileIds: createdItems.map(item => item.fileId), bytes: createdItems.reduce((sum, item) => sum + item.sizeBytes, 0),
          result: { keepCopyProtocol: KEEP_COPY_PROTOCOL, keepCopyRequired: createdItems.some(item => item.requiresKeepCopy), purgeItems: createdItems } });
        for (const item of createdItems) await ctx.db.patch(item.quarantineItemId as any, { status: "pending_purge" });
      }
    }
  }
  if (job.action === "quarantine" && terminal) {
    // Confirmed moves above are soft-deleted. Remaining rows were not moved by
    // this finished attempt and may be selected again after an explicit retry.
    for (const fileId of job.affectedFileIds) {
      const fid = ctx.db.normalizeId("files", fileId);
      const file = fid ? inTenant(await ctx.db.get(fid), tenantId) : null;
      if (file?.pendingCleanupJobId === String(job._id))
        await ctx.db.patch(file._id, { pendingCleanupJobId: undefined });
    }
  }
  if (job.action === "restore" && terminal) {
    const qid = ctx.db.normalizeId("quarantineItems", job.result?.quarantineId ?? "");
    const item = qid ? inTenant(await ctx.db.get(qid), tenantId) : null;
    if (args.status === "completed") {
      if (!item || !(args.result?.restoredQuarantineIds ?? []).includes(String(item._id))) throw new ConvexError("The agent did not confirm the restore.");
      await finishRestore(ctx, item, tenantId);
    } else if (item?.status === "pending_restore") await ctx.db.patch(item._id, { status: "quarantined" });
  }
  if (job.action === "purge" && terminal) {
    const allowed = new Set((job.result?.purgeItems ?? []).map((i: any) => i.quarantineItemId));
    const purged = new Set<string>(args.result?.purgedItemIds ?? []);
    for (const qid of purged) if (!allowed.has(qid)) throw new ConvexError("Unexpected purge confirmation.");
    for (const itemId of allowed) {
      const qid = ctx.db.normalizeId("quarantineItems", itemId as string);
      const item = qid ? inTenant(await ctx.db.get(qid), tenantId) : null;
      if (!item || await quarantineMachine(ctx, item, tenantId) !== job.machineId) continue;
      await ctx.db.patch(item._id, purged.has(String(item._id)) ? { status: "permanently_deleted", deletedAt: now } : { status: "quarantined" });
    }
  }
  if (job.action === "generate_manifest" && args.status === "failed" && job.result?.verify && job.result?.projectId) {
    const manifests = await ctx.db.query("archiveManifests").withIndex("by_tenant", q => q.eq("tenantId", tenantId))
      .order("desc").filter(q => q.eq(q.field("projectId"), job.result.projectId)).take(50);
    for (const manifest of manifests) {
      if (manifest.status === "verified" && manifest.checksum === job.result.expectedManifestChecksum)
        await ctx.db.patch(manifest._id, { status: "failed", verificationResult: { verified: false, error: result.error ?? "Agent checksum verification failed." } });
    }
  }
  await ctx.db.patch(job._id, { ...lease.patch, status: args.status, result, updatedAt: now });
  if (terminal) {
    const related = job.result?.recommendationIds ?? (job.recommendationId ? [job.recommendationId] : []);
    const siblings = job.result?.batchJobIds ?? [String(job._id)];
    const siblingJobs = [];
    for (const sid of siblings) {
      const siblingId = ctx.db.normalizeId("cleanupJobs", sid);
      const sibling = siblingId ? inTenant(await ctx.db.get(siblingId), tenantId) : null;
      if (sibling) siblingJobs.push(sibling);
    }
    const status = siblingJobs.some(j => j.status === "failed") ? "failed" : siblingJobs.every(j => j.status === "completed") ? "completed" : "approved";
    for (const recId of related) {
      const rid = ctx.db.normalizeId("recommendations", recId);
      const rec = rid ? inTenant(await ctx.db.get(rid), tenantId) : null;
      if (rec) await ctx.db.patch(rec._id, { status, updatedAt: now });
    }
    if (siblingJobs.every(j => ["completed", "failed"].includes(j.status))) {
      const clusterIds: string[] = job.result?.clusterIds ?? (job.result?.clusterId ? [job.result.clusterId] : []);
      for (const clusterId of clusterIds) {
        const cid = ctx.db.normalizeId("duplicateClusters", clusterId);
        const cluster = cid ? inTenant(await ctx.db.get(cid), tenantId) : null;
        if (cluster && cluster.status === "queued") await ctx.db.patch(cluster._id, { status: cluster.fileCount < 2 ? "resolved" : "open", updatedAt: now });
      }
    }
  }
  await ctx.db.insert("auditLogs", { tenantId, machineId: job.machineId, action: `job_${args.status}`, entityType: "cleanupJob", entityId: job._id,
    message: `Agent ${job.action} job ${args.status}.`, createdAt: now });
  return { claimed: true, claimToken: lease.patch.claimToken ?? job.claimToken, leaseExpiresAt: lease.patch.leaseExpiresAt };
}});
