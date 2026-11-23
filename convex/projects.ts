import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireMember, requireRole, inTenant } from "./access";
import { cleanupRulesValidator, DEFAULT_CLEANUP_RULES, validateCleanupRules } from "./settings";
import { insertApprovedJob } from "./jobUtils";
import { invalidateAnalysisInputs } from "./catalogAnalysis";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("projects")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
  },
});

export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const id = ctx.db.normalizeId("projects", args.projectId);
    if (!id) return null;
    return inTenant(await ctx.db.get(id), tenantId);
  },
});

// Agent-only (internal): fetch a project scoped to the agent's tenant.
export const getForAgent = internalQuery({
  args: { projectId: v.string(), tenantId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("projects", args.projectId);
    if (!id) return null;
    const project = await ctx.db.get(id);
    if (!project || project.tenantId !== (args.tenantId || "")) return null;
    return project;
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
    driveId: v.optional(v.string()),
    rules: v.optional(cleanupRulesValidator),
    cloudRequested: v.optional(v.boolean()),
    folderTemplateId: v.optional(v.string()),
    template: v.optional(v.string()), // friendly template name
    dueDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const member = await requireRole(ctx, ["admin", "producer", "editor", "assistant_editor"]);
    const { tenantId } = member;
    const timestamp = Date.now();
    const slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!args.name.trim() || !args.client.trim()) throw new ConvexError("Project name and client are required.");
    if (args.cloudRequested) throw new ConvexError("Cloud folder creation is not available yet.");
    if (args.template && args.template !== "YouTube Show") throw new ConvexError("Only the studio standard folder template is currently supported.");
    const rules = args.rules ?? DEFAULT_CLEANUP_RULES;
    validateCleanupRules(rules);
    let drive: any = null;
    if (args.driveId) {
      const did = ctx.db.normalizeId("drives", args.driveId);
      drive = did ? inTenant(await ctx.db.get(did), tenantId) : null;
      if (!drive) throw new ConvexError("Choose a tracked drive in this workspace.");
    }
    if (args.rootPath) {
      const normalized = args.rootPath.replace(/\\/g, "/");
      if (!/^(?:[A-Za-z]:\/|\/)/.test(normalized) || normalized.includes("\0") || normalized.split("/").some(p => p === ".." || p === "."))
        throw new ConvexError("Choose an absolute project folder without relative path segments.");
      const key = (s: string) => {
        const value = s.replace(/\\/g, "/").replace(/\/+$/, "");
        return /^(?:[A-Za-z]:|\/\/)/.test(value) ? value.toLowerCase() : value;
      };
      const inside = (root: string) => key(normalized) === key(root) || key(normalized).startsWith(key(root) + "/");
      if (!drive) {
        const candidates = await ctx.db.query("drives").withIndex("by_tenant", q => q.eq("tenantId", tenantId)).collect();
        drive = candidates.filter(d => inside(d.mountPath)).sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
      }
      if (!drive?.machineId || !inside(drive.mountPath)) throw new ConvexError("The project folder must be inside the selected tracked drive.");
      const mid = ctx.db.normalizeId("machines", drive.machineId);
      const machine = mid ? inTenant(await ctx.db.get(mid), tenantId) : null;
      if (!machine) throw new ConvexError("The selected drive is not linked to a machine.");
    }

    const projectId = await ctx.db.insert("projects", {
      tenantId,
      name: args.name,
      client: args.client,
      showName: args.showName,
      episode: args.episode,
      slug,
      ownerId: args.ownerId,
      status: args.status,
      tier: args.tier,
      rootPath: args.rootPath,
      driveId: drive ? String(drive._id) : undefined,
      machineId: drive?.machineId,
      cleanupRules: rules,
      folderTemplateId: args.folderTemplateId,
      template: args.template,
      dueDate: args.dueDate,
      createdAt: timestamp,
      storageHealthScore: 0, // health is unknown until files are scanned and analyzed
      totalBytes: 0,
      duplicateBytes: 0,
      safeCleanupBytes: 0,
      riskyBytes: 0,
      notes: args.notes,
    });
    await invalidateAnalysisInputs(ctx, tenantId);

    // Create a background job for local agent to create the folder structure if rootPath is specified
    if (args.rootPath) {
      const setupJobId = await insertApprovedJob(ctx, {
        tenantId, machineId: drive.machineId, requestedBy: member.email, action: "create_folder_structure",
        result: {
          projectId,
          projectName: args.name,
          client: args.client,
          showName: args.showName || "",
          owner: args.ownerId,
          rootPath: args.rootPath,
          template: args.template || "YouTube Show",
        },
      });
      await ctx.db.patch(projectId, { setupJobId: String(setupJobId) });
    }

    await ctx.db.insert("auditLogs", {
      tenantId,
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

export const setupStatus = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const id = ctx.db.normalizeId("projects", args.projectId);
    const project = id ? inTenant(await ctx.db.get(id), tenantId) : null;
    if (!project) return null;
    const jid = project.setupJobId ? ctx.db.normalizeId("cleanupJobs", project.setupJobId) : null;
    const job = jid ? inTenant(await ctx.db.get(jid), tenantId) : null;
    return { status: job?.status ?? "not_requested", jobId: job?._id,
      error: job?.result?.error ?? job?.result?.failures?.[0]?.error };
  },
});

export const updateStatus = mutation({
  args: {
    projectId: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireRole(ctx, ["admin", "producer", "editor", "assistant_editor"]);
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return;

    const project = inTenant(await ctx.db.get(projectId), tenantId);
    if (!project) return;

    if (args.status === "archived") {
      const latest = await ctx.db.query("archiveManifests").withIndex("by_tenant", q => q.eq("tenantId", tenantId))
        .order("desc").filter(q => q.eq(q.field("projectId"), args.projectId)).first();
      if (!latest || latest.status !== "verified" || !latest.manifestPath.replace(/\\/g, "/").endsWith("/archive_manifest.json"))
        throw new ConvexError("Generate and verify the project's inventory manifest before marking it archived.");
    }

    await ctx.db.patch(projectId, {
      status: args.status,
      archivedAt: args.status === "archived" ? Date.now() : project.archivedAt,
    });
    if (project.status !== args.status) await invalidateAnalysisInputs(ctx, tenantId);

    await ctx.db.insert("auditLogs", {
      tenantId,
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
    const { tenantId } = await requireMember(ctx);
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return;
    const project = inTenant(await ctx.db.get(projectId), tenantId);
    if (!project) return;

    await ctx.db.patch(projectId, {
      totalBytes: args.totalBytes,
      duplicateBytes: args.duplicateBytes,
      safeCleanupBytes: args.safeCleanupBytes,
      riskyBytes: args.riskyBytes,
      storageHealthScore: args.storageHealthScore,
    });
    if (project.storageHealthScore !== args.storageHealthScore) await invalidateAnalysisInputs(ctx, tenantId);
  },
});

export const listTemplates = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    const own = await ctx.db
      .query("folderTemplates")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
    if (own.length > 0) return own;
    // Fall back to shared/global default templates (no tenant assigned).
    return await ctx.db
      .query("folderTemplates")
      .withIndex("by_tenant", (q) => q.eq("tenantId", undefined))
      .collect();
  },
});
