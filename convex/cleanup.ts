import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireMember, inTenant } from "./access";

export const listJobs = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("cleanupJobs")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .collect();
  },
});

export const listQuarantine = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("quarantineItems")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
  },
});

// How many quarantined items in the caller's tenant are past their rollback
// window and safe to purge. Drives the "Empty expired" button count/disabled.
export const purgeableCount = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    const now = Date.now();
    const items = await ctx.db
      .query("quarantineItems")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
    const expired = items.filter((i) => i.status === "quarantined" && i.rollbackUntil <= now);
    return {
      count: expired.length,
      bytes: expired.reduce((s, i) => s + i.sizeBytes, 0),
    };
  },
});

// Permanently delete quarantined files past their 14-day window, scoped to the
// caller's tenant. Manual only (a human clicks the button) — never auto-runs.
// Creates an approved purge job carrying the file paths so the per-machine agent
// can delete them off disk; items flip to "pending_purge" so they can't double-queue.
export const purgeExpired = mutation({
  args: { requestedBy: v.string() },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const now = Date.now();

    const items = await ctx.db
      .query("quarantineItems")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
    const expired = items.filter((i) => i.status === "quarantined" && i.rollbackUntil <= now);
    if (expired.length === 0) return { queued: 0 };

    const purgeItems = expired.map((i) => ({
      quarantineItemId: String(i._id),
      quarantinePath: i.quarantinePath,
    }));
    const totalBytes = expired.reduce((s, i) => s + i.sizeBytes, 0);

    const jobId = await ctx.db.insert("cleanupJobs", {
      tenantId,
      requestedBy: args.requestedBy,
      action: "purge",
      status: "approved", // skips pending_approval: the button click IS the approval
      approvedBy: args.requestedBy,
      affectedFileIds: expired.map((i) => i.fileId),
      affectedBytes: totalBytes,
      result: { purgeItems },
      createdAt: now,
      updatedAt: now,
    });

    for (const item of expired) {
      await ctx.db.patch(item._id, { status: "pending_purge" });
    }

    await ctx.db.insert("auditLogs", {
      tenantId,
      actorId: args.requestedBy,
      action: "purge_request",
      entityType: "cleanupJob",
      entityId: jobId,
      message: `Queued permanent deletion of ${expired.length} expired quarantine item(s), freeing ${(totalBytes / (1024 ** 3)).toFixed(1)} GB`,
      createdAt: now,
    });

    return { queued: expired.length, jobId };
  },
});

// Agent-only (internal): fetch a job + its files, scoped to the agent's tenant.
export const getJob = internalQuery({
  args: { jobId: v.string(), tenantId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
    if (!id) return null;

    const job = await ctx.db.get(id);
    if (!job || job.tenantId !== tenantId) return null;

    const files = [];
    for (const fId of job.affectedFileIds) {
      const fileId = ctx.db.normalizeId("files", fId);
      if (fileId) {
        const file = await ctx.db.get(fileId);
        if (file && file.tenantId === tenantId) files.push(file);
      }
    }

    return { ...job, files };
  },
});

// Agent-only (internal).
export const getQuarantineItem = internalQuery({
  args: { quarantineId: v.string(), tenantId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const id = ctx.db.normalizeId("quarantineItems", args.quarantineId);
    if (!id) return null;
    const item = await ctx.db.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    return item;
  },
});

export const createJob = mutation({
  args: {
    recommendationId: v.optional(v.string()),
    machineId: v.optional(v.string()),
    requestedBy: v.string(),
    action: v.string(), // "quarantine" | "restore" | "generate_manifest" | "create_folder_structure"
    affectedFileIds: v.array(v.string()),
    affectedBytes: v.number(),
    // "Delete permanently" from the Cleanup page: still a quarantine job (so the
    // protected-file guard applies), but flagged to auto-purge once moved.
    purgeAfter: v.optional(v.boolean()),
    result: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const timestamp = Date.now();
    const rollbackPeriod = 14 * 24 * 60 * 60 * 1000;

    const jobId = await ctx.db.insert("cleanupJobs", {
      tenantId,
      recommendationId: args.recommendationId,
      machineId: args.machineId,
      requestedBy: args.requestedBy,
      action: args.action,
      status: "pending_approval",
      affectedFileIds: args.affectedFileIds,
      affectedBytes: args.affectedBytes,
      // A purge-after job keeps a zero rollback window: the file is meant to be
      // deleted, not held for 14 days.
      rollbackUntil: args.action === "quarantine" && !args.purgeAfter ? timestamp + rollbackPeriod : undefined,
      purgeAfter: args.purgeAfter || undefined,
      result: args.result,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await ctx.db.insert("auditLogs", {
      tenantId,
      actorId: args.requestedBy,
      machineId: args.machineId,
      action: "job_create",
      entityType: "cleanupJob",
      entityId: jobId,
      message: `Created cleanup job for action "${args.action}"${args.purgeAfter ? " (permanent delete)" : ""} affecting ${(args.affectedBytes / (1024 ** 3)).toFixed(1)} GB`,
      createdAt: timestamp,
    });

    return jobId;
  },
});

export const approveJob = mutation({
  args: {
    jobId: v.string(),
    approvedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
    if (!id) return;

    const job = inTenant(await ctx.db.get(id), tenantId);
    if (!job) return;

    const timestamp = Date.now();
    await ctx.db.patch(id, {
      status: "approved",
      approvedBy: args.approvedBy,
      updatedAt: timestamp,
    });

    if (job.recommendationId) {
      const recId = ctx.db.normalizeId("recommendations", job.recommendationId);
      const rec = recId ? inTenant(await ctx.db.get(recId), tenantId) : null;
      if (recId && rec) {
        await ctx.db.patch(recId, {
          status: "approved",
          updatedAt: timestamp,
        });
      }
    }

    await ctx.db.insert("auditLogs", {
      tenantId,
      actorId: args.approvedBy,
      action: "job_approve",
      entityType: "cleanupJob",
      entityId: id,
      message: `Approved cleanup job for action "${job.action}" requested by ${job.requestedBy}`,
      createdAt: timestamp,
    });
  },
});

// ---- CLI Agent Endpoints (internal: reached only via the authenticated HTTP route) ----

export const pollPendingJobs = internalQuery({
  args: { machineId: v.string(), tenantId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    // Only the two actionable statuses, via the (tenant,status) index — never
    // the whole job history. This query runs on every agent poll, so reading the
    // full cleanupJobs table (which accumulates completed/failed rows forever,
    // and now also the auto-purge jobs from "Delete permanently") would grow
    // more expensive every day the workspace is used. Bounded read = stable cost.
    const approved = await ctx.db
      .query("cleanupJobs")
      .withIndex("by_tenant_status", (q) => q.eq("tenantId", tenantId).eq("status", "approved"))
      .take(200);
    const queued = await ctx.db
      .query("cleanupJobs")
      .withIndex("by_tenant_status", (q) => q.eq("tenantId", tenantId).eq("status", "queued"))
      .take(200);

    const machineJobs = [...approved, ...queued].filter(
      (job) => !job.machineId || job.machineId === args.machineId
    );

    const hydratedJobs = [];
    for (const job of machineJobs) {
      const filesList = [];
      for (const fId of job.affectedFileIds) {
        const fileIdObj = ctx.db.normalizeId("files", fId);
        if (fileIdObj) {
          const file = await ctx.db.get(fileIdObj);
          if (file && file.tenantId === tenantId) filesList.push(file);
        }
      }
      hydratedJobs.push({ ...job, files: filesList });
    }

    return hydratedJobs;
  },
});

export const updateJobStatus = internalMutation({
  args: {
    jobId: v.string(),
    status: v.string(), // "running" | "completed" | "failed"
    result: v.optional(v.any()),
    tenantId: v.optional(v.string()),
    quarantineFiles: v.optional(
      v.array(
        v.object({
          fileId: v.string(),
          originalPath: v.string(),
          quarantinePath: v.string(),
          sizeBytes: v.number(),
        })
      )
    ),
  },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
    if (!id) return;

    const job = await ctx.db.get(id);
    if (!job || job.tenantId !== tenantId) return;

    const timestamp = Date.now();
    await ctx.db.patch(id, {
      status: args.status,
      result: args.result || job.result,
      updatedAt: timestamp,
    });

    if (args.status === "completed") {
      if (job.action === "quarantine" && args.quarantineFiles) {
        // Collect the freshly-created quarantine items so a purge-after job can
        // reference them by id + on-disk path.
        const createdItems: { quarantineItemId: string; quarantinePath: string }[] = [];
        for (const qf of args.quarantineFiles) {
          const fileIdObj = ctx.db.normalizeId("files", qf.fileId);

          const qItemId = await ctx.db.insert("quarantineItems", {
            tenantId,
            cleanupJobId: args.jobId,
            originalPath: qf.originalPath,
            quarantinePath: qf.quarantinePath,
            fileId: qf.fileId,
            sizeBytes: qf.sizeBytes,
            movedAt: timestamp,
            // purge-after items get no rollback window (immediate delete intent).
            rollbackUntil: job.purgeAfter ? timestamp : (job.rollbackUntil || (timestamp + 14 * 24 * 60 * 60 * 1000)),
            status: "quarantined",
          });
          createdItems.push({ quarantineItemId: String(qItemId), quarantinePath: qf.quarantinePath });

          if (fileIdObj) {
            const file = await ctx.db.get(fileIdObj);
            if (file && file.tenantId === tenantId) {
              await ctx.db.patch(fileIdObj, { deletedAt: timestamp });
            }
          }
        }

        // "Delete permanently" flow: the file has moved to quarantine and is
        // blocked-or-not by the same protected-file guard as any quarantine.
        // Now auto-queue an approved purge job so the agent erases exactly those
        // items from disk on its next poll. Only queues if something moved.
        if (job.purgeAfter && createdItems.length > 0) {
          const purgeJobId = await ctx.db.insert("cleanupJobs", {
            tenantId,
            machineId: job.machineId,
            requestedBy: job.requestedBy,
            action: "purge",
            status: "approved", // auto-approved: the type-to-confirm delete WAS the approval
            approvedBy: job.approvedBy || job.requestedBy,
            affectedFileIds: job.affectedFileIds,
            affectedBytes: job.affectedBytes,
            result: { purgeItems: createdItems },
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          await ctx.db.insert("auditLogs", {
            tenantId,
            machineId: job.machineId,
            action: "purge_request",
            entityType: "cleanupJob",
            entityId: purgeJobId,
            message: `Auto-queued permanent deletion of ${createdItems.length} quarantined item(s) (Delete permanently)`,
            createdAt: timestamp,
          });
        }
      }

      if (job.action === "restore") {
        const fileId = job.affectedFileIds[0];
        if (fileId) {
          const fileIdObj = ctx.db.normalizeId("files", fileId);
          if (fileIdObj) {
            const file = await ctx.db.get(fileIdObj);
            if (file && file.tenantId === tenantId) {
              await ctx.db.patch(fileIdObj, { deletedAt: undefined });
            }
          }

          const qItems = await ctx.db
            .query("quarantineItems")
            .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
            .filter((q) => q.eq(q.field("fileId"), fileId))
            .collect();

          for (const item of qItems) {
            await ctx.db.patch(item._id, {
              status: "restored",
              restoredAt: timestamp,
            });
          }
        }
      }

      // Purge job finalize: only the items the agent confirms deleted flip to
      // permanently_deleted, so a partial failure leaves the rest recoverable.
      // Each item is re-checked against the tenant before mutating.
      if (job.action === "purge") {
        const purgedIds: string[] = (args.result && args.result.purgedItemIds) || [];
        for (const itemId of purgedIds) {
          const qid = ctx.db.normalizeId("quarantineItems", itemId);
          if (!qid) continue;
          const item = await ctx.db.get(qid);
          if (item && item.tenantId === tenantId) {
            await ctx.db.patch(qid, { status: "permanently_deleted", deletedAt: timestamp });
          }
        }
      }

      if (job.recommendationId) {
        const recId = ctx.db.normalizeId("recommendations", job.recommendationId);
        if (recId) {
          const rec = await ctx.db.get(recId);
          if (rec && rec.tenantId === tenantId) {
            await ctx.db.patch(recId, { status: "completed", updatedAt: timestamp });
          }
        }
      }
    }

    await ctx.db.insert("auditLogs", {
      tenantId,
      machineId: job.machineId,
      action: `job_${args.status}`,
      entityType: "cleanupJob",
      entityId: id,
      message: `Cleanup job ${job.action} status changed to ${args.status}`,
      createdAt: timestamp,
    });
  },
});

// Dashboard "Restore" button — restores a quarantined file in the caller's tenant.
export const markQuarantineRestored = mutation({
  args: { quarantineId: v.string() },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    await restoreQuarantine(ctx, args.quarantineId, tenantId);
  },
});

// Agent variant (internal): same restore, tenant from the verified machine token.
export const markQuarantineRestoredAgent = internalMutation({
  args: { quarantineId: v.string(), tenantId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await restoreQuarantine(ctx, args.quarantineId, args.tenantId || "");
  },
});

async function restoreQuarantine(ctx: any, quarantineId: string, tenantId: string) {
  const id = ctx.db.normalizeId("quarantineItems", quarantineId);
  if (!id) return;

  const item = await ctx.db.get(id);
  if (!item || item.tenantId !== tenantId) return;

  const timestamp = Date.now();
  await ctx.db.patch(id, {
    status: "restored",
    restoredAt: timestamp,
  });

  const fileId = ctx.db.normalizeId("files", item.fileId);
  if (fileId) {
    const file = await ctx.db.get(fileId);
    if (file && file.tenantId === tenantId) {
      await ctx.db.patch(fileId, {
        deletedAt: undefined,
        lastSeenAt: timestamp,
      });
    }
  }

  await ctx.db.insert("auditLogs", {
    tenantId,
    action: "quarantine_restore",
    entityType: "quarantineItem",
    entityId: id,
    message: `Restored quarantined file ${item.originalPath}`,
    createdAt: timestamp,
  });
}
