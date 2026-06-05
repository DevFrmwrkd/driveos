import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const listJobs = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("cleanupJobs").order("desc").collect();
  },
});

export const listQuarantine = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("quarantineItems").collect();
  },
});

export const getJob = query({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
    if (!id) return null;

    const job = await ctx.db.get(id);
    if (!job) return null;

    const files = [];
    for (const fId of job.affectedFileIds) {
      const fileId = ctx.db.normalizeId("files", fId);
      if (fileId) {
        const file = await ctx.db.get(fileId);
        if (file) files.push(file);
      }
    }

    return { ...job, files };
  },
});

export const getQuarantineItem = query({
  args: { quarantineId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("quarantineItems", args.quarantineId);
    if (!id) return null;
    return await ctx.db.get(id);
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
    result: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    // Default rollback duration: 14 days (14 * 24 * 60 * 60 * 1000)
    const rollbackPeriod = 14 * 24 * 60 * 60 * 1000;

    const jobId = await ctx.db.insert("cleanupJobs", {
      recommendationId: args.recommendationId,
      machineId: args.machineId,
      requestedBy: args.requestedBy,
      action: args.action,
      status: "pending_approval",
      affectedFileIds: args.affectedFileIds,
      affectedBytes: args.affectedBytes,
      rollbackUntil: args.action === "quarantine" ? timestamp + rollbackPeriod : undefined,
      result: args.result,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await ctx.db.insert("auditLogs", {
      actorId: args.requestedBy,
      machineId: args.machineId,
      action: "job_create",
      entityType: "cleanupJob",
      entityId: jobId,
      message: `Created cleanup job for action "${args.action}" affecting ${(args.affectedBytes / (1024 ** 9)).toFixed(1)} GB`,
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
    const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
    if (!id) return;

    const job = await ctx.db.get(id);
    if (!job) return;

    const timestamp = Date.now();
    await ctx.db.patch(id, {
      status: "approved",
      approvedBy: args.approvedBy,
      updatedAt: timestamp,
    });

    // Mark recommendation as completed or approved
    if (job.recommendationId) {
      const recId = ctx.db.normalizeId("recommendations", job.recommendationId);
      if (recId) {
        await ctx.db.patch(recId, {
          status: "approved",
          updatedAt: timestamp,
        });
      }
    }

    await ctx.db.insert("auditLogs", {
      actorId: args.approvedBy,
      action: "job_approve",
      entityType: "cleanupJob",
      entityId: id,
      message: `Approved cleanup job for action "${job.action}" requested by ${job.requestedBy}`,
      createdAt: timestamp,
    });
  },
});

// ---- CLI Agent Endpoints ----

export const pollPendingJobs = query({
  args: { machineId: v.string() },
  handler: async (ctx, args) => {
    // Return approved or queued jobs for this machine
    const approvedJobs = await ctx.db
      .query("cleanupJobs")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .collect();

    const queuedJobs = await ctx.db
      .query("cleanupJobs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect();

    const machineJobs = [...approvedJobs, ...queuedJobs].filter(
      (job) => !job.machineId || job.machineId === args.machineId
    );

    // Hydrate job files if needed
    const hydratedJobs = [];
    for (const job of machineJobs) {
      const filesList = [];
      for (const fId of job.affectedFileIds) {
        const fileIdObj = ctx.db.normalizeId("files", fId);
        if (fileIdObj) {
          const file = await ctx.db.get(fileIdObj);
          if (file) filesList.push(file);
        }
      }
      hydratedJobs.push({ ...job, files: filesList });
    }

    return hydratedJobs;
  },
});

export const updateJobStatus = mutation({
  args: {
    jobId: v.string(),
    status: v.string(), // "running" | "completed" | "failed"
    result: v.optional(v.any()),
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
    const id = ctx.db.normalizeId("cleanupJobs", args.jobId);
    if (!id) return;

    const job = await ctx.db.get(id);
    if (!job) return;

    const timestamp = Date.now();
    await ctx.db.patch(id, {
      status: args.status,
      result: args.result || job.result,
      updatedAt: timestamp,
    });

    if (args.status === "completed") {
      // If it's a quarantine job, insert the quarantineItems
      if (job.action === "quarantine" && args.quarantineFiles) {
        for (const qf of args.quarantineFiles) {
          const fileIdObj = ctx.db.normalizeId("files", qf.fileId);

          await ctx.db.insert("quarantineItems", {
            cleanupJobId: args.jobId,
            originalPath: qf.originalPath,
            quarantinePath: qf.quarantinePath,
            fileId: qf.fileId,
            sizeBytes: qf.sizeBytes,
            movedAt: timestamp,
            rollbackUntil: job.rollbackUntil || (timestamp + 14 * 24 * 60 * 60 * 1000),
            status: "quarantined",
          });

          // Soft delete file from active listing
          if (fileIdObj) {
            await ctx.db.patch(fileIdObj, {
              deletedAt: timestamp,
            });
          }
        }
      }

      // If it's a restore job, restore quarantine items
      if (job.action === "restore") {
        const fileId = job.affectedFileIds[0];
        if (fileId) {
          const fileIdObj = ctx.db.normalizeId("files", fileId);
          if (fileIdObj) {
            await ctx.db.patch(fileIdObj, {
              deletedAt: undefined, // restore it
            });
          }

          // Mark quarantine item as restored
          const qItems = await ctx.db
            .query("quarantineItems")
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

      // Update recommendation status to completed
      if (job.recommendationId) {
        const recId = ctx.db.normalizeId("recommendations", job.recommendationId);
        if (recId) {
          await ctx.db.patch(recId, {
            status: "completed",
            updatedAt: timestamp,
          });
        }
      }
    }

    await ctx.db.insert("auditLogs", {
      machineId: job.machineId,
      action: `job_${args.status}`,
      entityType: "cleanupJob",
      entityId: id,
      message: `Cleanup job ${job.action} status changed to ${args.status}`,
      createdAt: timestamp,
    });
  },
});

export const markQuarantineRestored = mutation({
  args: { quarantineId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("quarantineItems", args.quarantineId);
    if (!id) return;

    const item = await ctx.db.get(id);
    if (!item) return;

    const timestamp = Date.now();
    await ctx.db.patch(id, {
      status: "restored",
      restoredAt: timestamp,
    });

    const fileId = ctx.db.normalizeId("files", item.fileId);
    if (fileId) {
      await ctx.db.patch(fileId, {
        deletedAt: undefined,
        lastSeenAt: timestamp,
      });
    }

    await ctx.db.insert("auditLogs", {
      action: "quarantine_restore",
      entityType: "quarantineItem",
      entityId: id,
      message: `Restored quarantined file ${item.originalPath}`,
      createdAt: timestamp,
    });
  },
});
