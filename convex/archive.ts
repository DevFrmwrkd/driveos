import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const listManifests = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("archiveManifests").collect();
  },
});

export const getManifest = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("archiveManifests")
      .filter((q) => q.eq(q.field("projectId"), args.projectId))
      .first();
  },
});

export const createManifest = mutation({
  args: {
    projectId: v.string(),
    driveId: v.optional(v.string()),
    createdBy: v.string(),
    fileCount: v.number(),
    totalBytes: v.number(),
    manifestPath: v.string(),
    checksum: v.string(),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const manifestId = await ctx.db.insert("archiveManifests", {
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
    const id = ctx.db.normalizeId("archiveManifests", args.manifestId);
    if (!id) return;

    const manifest = await ctx.db.get(id);
    if (!manifest) return;

    await ctx.db.patch(id, {
      status: args.status,
      verificationResult: args.verificationResult,
    });

    await ctx.db.insert("auditLogs", {
      action: "manifest_verify",
      entityType: "archiveManifest",
      entityId: id,
      message: `Checksum verification for manifest at ${manifest.manifestPath} resulted in: ${args.status}`,
      createdAt: Date.now(),
    });
  },
});
