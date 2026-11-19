import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireMember, requireRole, inTenant } from "./access";
import { insertApprovedJob } from "./jobUtils";

export const requestManifest = mutation({
  args: { projectId: v.string(), verify: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const member = await requireRole(ctx, ["admin", "producer", "editor", "assistant_editor"]);
    const id = ctx.db.normalizeId("projects", args.projectId);
    const project = id ? inTenant(await ctx.db.get(id), member.tenantId) : null;
    if (!project?.rootPath) throw new ConvexError("The project needs a local root folder before a manifest can be generated.");
    let machineId = project.machineId;
    if (!machineId && project.driveId) {
      const did = ctx.db.normalizeId("drives", project.driveId);
      const drive = did ? inTenant(await ctx.db.get(did), member.tenantId) : null;
      machineId = drive?.machineId;
    }
    if (!machineId) throw new ConvexError("The project is not linked to a machine. Recreate its storage setup first.");
    let expectedManifestChecksum: string | undefined;
    if (args.verify) {
      const manifests = await ctx.db.query("archiveManifests").withIndex("by_tenant", q => q.eq("tenantId", member.tenantId))
        .order("desc").filter(q => q.eq(q.field("projectId"), args.projectId)).take(50);
      const manifest = manifests.find(m => ["generated", "verified"].includes(m.status) && m.manifestPath.replace(/\\/g, "/").endsWith("/archive_manifest.json"));
      if (!manifest) throw new ConvexError("Generate an inventory manifest before requesting verification.");
      expectedManifestChecksum = manifest.checksum;
    }
    const active = await ctx.db.query("cleanupJobs").withIndex("by_tenant", q => q.eq("tenantId", member.tenantId)).order("desc").take(200);
    const existing = active.find(j => j.action === "generate_manifest" && j.result?.projectId === args.projectId && ["approved", "queued", "running"].includes(j.status));
    if (existing) return { jobId: existing._id };
    const jobId = await insertApprovedJob(ctx, { tenantId: member.tenantId, machineId,
      requestedBy: member.email, action: "generate_manifest",
      result: { projectId: args.projectId, rootPath: project.rootPath, verify: Boolean(args.verify), expectedManifestChecksum },
    });
    return { jobId };
  },
});

export const listManifests = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("archiveManifests")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
  },
});

export const getManifest = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("archiveManifests")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .first();
  },
});

// Agent-only (internal): record an archive manifest in the agent's tenant.
export const createManifest = internalMutation({
  args: {
    projectId: v.string(),
    driveId: v.optional(v.string()),
    createdBy: v.string(),
    fileCount: v.number(),
    totalBytes: v.number(),
    manifestPath: v.string(),
    checksum: v.string(),
    verificationResult: v.optional(v.any()),
    tenantId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const timestamp = Date.now();
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    const project = projectId ? inTenant(await ctx.db.get(projectId), tenantId) : null;
    if (!project) throw new ConvexError("Unknown project for manifest.");
    const manifestId = await ctx.db.insert("archiveManifests", {
      tenantId,
      projectId: args.projectId,
      driveId: args.driveId,
      createdBy: args.createdBy,
      createdAt: timestamp,
      fileCount: args.fileCount,
      totalBytes: args.totalBytes,
      manifestPath: args.manifestPath,
      checksum: args.checksum,
      status: args.verificationResult?.verified === true ? "verified" : args.verificationResult?.verified === false ? "failed" : "generated",
      verificationResult: args.verificationResult,
    });

    await ctx.db.insert("auditLogs", {
      tenantId,
      actorId: args.createdBy,
      action: "manifest_generate",
      entityType: "archiveManifest",
      entityId: manifestId,
      message: `Generated archive manifest for project ${args.projectId} with ${args.fileCount} files (${(args.totalBytes / (1024 ** 3)).toFixed(1)} GB)`,
      createdAt: timestamp,
    });

    return manifestId;
  },
});

export const verifyManifest = mutation({
  args: {
    manifestId: v.string(),
    status: v.string(), // "verified" | "failed"
    verificationResult: v.any(),
  },
  handler: async (ctx, args) => {
    await requireMember(ctx);
    throw new ConvexError("Verification must be performed by the local agent. Use Request verification for the project.");
  },
});
