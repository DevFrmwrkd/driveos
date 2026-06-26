import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireMember, inTenant } from "./access";

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
    tenantId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const timestamp = Date.now();
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
      status: "generated",
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
    const { tenantId } = await requireMember(ctx);
    const id = ctx.db.normalizeId("archiveManifests", args.manifestId);
    if (!id) return;

    const manifest = inTenant(await ctx.db.get(id), tenantId);
    if (!manifest) return;

    await ctx.db.patch(id, {
      status: args.status,
      verificationResult: args.verificationResult,
    });

    await ctx.db.insert("auditLogs", {
      tenantId,
      action: "manifest_verify",
      entityType: "archiveManifest",
      entityId: id,
      message: `Checksum verification for manifest at ${manifest.manifestPath} resulted in: ${args.status}`,
      createdAt: Date.now(),
    });
  },
});
