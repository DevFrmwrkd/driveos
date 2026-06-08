import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./access";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("projects").collect();
  },
});

export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("projects", args.projectId);
    if (!id) return null;
    return await ctx.db.get(id);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    client: v.string(),
    showName: v.optional(v.string()),
    episode: v.optional(v.string()),
    ownerId: v.string(),
    status: v.string(), // "active" | "review" | "delivered" | "ready_to_archive" | "archived" | "paused"
    tier: v.string(), // "hot" | "warm" | "cloud" | "cold"
    rootPath: v.optional(v.string()),
    folderTemplateId: v.optional(v.string()),
    template: v.optional(v.string()), // friendly template name
    dueDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireMember(ctx);
    const timestamp = Date.now();
    const slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const projectId = await ctx.db.insert("projects", {
      name: args.name,
      client: args.client,
      showName: args.showName,
      episode: args.episode,
      slug,
      ownerId: args.ownerId,
      status: args.status,
      tier: args.tier,
      rootPath: args.rootPath,
      folderTemplateId: args.folderTemplateId,
      template: args.template,
      dueDate: args.dueDate,
      createdAt: timestamp,
      storageHealthScore: 100, // starts healthy
      totalBytes: 0,
      duplicateBytes: 0,
      safeCleanupBytes: 0,
      riskyBytes: 0,
      notes: args.notes,
    });

    // Create a background job for local agent to create the folder structure if rootPath is specified
    if (args.rootPath) {
      await ctx.db.insert("cleanupJobs", {
        action: "create_folder_structure",
        status: "pending_approval", // auto-approving below to queued
        requestedBy: args.ownerId,
        affectedFileIds: [],
        affectedBytes: 0,
        result: {
          projectId,
          projectName: args.name,
          client: args.client,
          showName: args.showName || "",
          owner: args.ownerId,
          rootPath: args.rootPath,
          template: args.template || "YouTube Show",
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    await ctx.db.insert("auditLogs", {
      actorId: args.ownerId,
      action: "project_create",
      entityType: "project",
      entityId: projectId,
      message: `Created project "${args.name}" for client "${args.client}"`,
      createdAt: timestamp,
    });

    return projectId;
  },
});

export const updateStatus = mutation({
  args: {
    projectId: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return;

    const project = await ctx.db.get(projectId);
    if (!project) return;

    await ctx.db.patch(projectId, {
      status: args.status,
      archivedAt: args.status === "archived" ? Date.now() : project.archivedAt,
    });

    await ctx.db.insert("auditLogs", {
      actorId: project.ownerId,
      action: "project_status_update",
      entityType: "project",
      entityId: projectId,
      message: `Updated project "${project.name}" status to "${args.status}"`,
      createdAt: Date.now(),
    });
  },
});

export const updateStats = mutation({
  args: {
    projectId: v.string(),
    totalBytes: v.number(),
    duplicateBytes: v.number(),
    safeCleanupBytes: v.number(),
    riskyBytes: v.number(),
    storageHealthScore: v.number(),
  },
  handler: async (ctx, args) => {
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return;

    await ctx.db.patch(projectId, {
      totalBytes: args.totalBytes,
      duplicateBytes: args.duplicateBytes,
      safeCleanupBytes: args.safeCleanupBytes,
      riskyBytes: args.riskyBytes,
      storageHealthScore: args.storageHealthScore,
    });
  },
});

export const listTemplates = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("folderTemplates").collect();
  },
});
