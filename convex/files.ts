import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";

export const list = query({
  args: {
    limit: v.optional(v.number()),
    driveId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    classification: v.optional(v.string()),
    riskLevel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.projectId) {
      return await ctx.db
        .query("files")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(args.limit || 50);
    }
    if (args.driveId) {
      return await ctx.db
        .query("files")
        .withIndex("by_drive", (q) => q.eq("driveId", args.driveId))
        .take(args.limit || 50);
    }
    if (args.classification) {
      const classification = args.classification;
      return await ctx.db
        .query("files")
        .withIndex("by_classification", (q) => q.eq("classification", classification))
        .take(args.limit || 50);
    }
    if (args.riskLevel) {
      const riskLevel = args.riskLevel;
      return await ctx.db
        .query("files")
        .withIndex("by_riskLevel", (q) => q.eq("riskLevel", riskLevel))
        .take(args.limit || 50);
    }

    return await ctx.db.query("files").take(args.limit || 50);
  },
});

export const getByHash = query({
  args: { fullHash: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("files")
      .withIndex("by_fullHash", (q) => q.eq("fullHash", args.fullHash))
      .collect();
  },
});

export const uploadBatch = mutation({
  args: {
    scanSessionId: v.string(),
    machineId: v.string(),
    driveId: v.optional(v.string()),
    files: v.array(
      v.object({
        path: v.string(),
        normalizedPath: v.string(),
        parentPath: v.string(),
        name: v.string(),
        extension: v.string(),
        sizeBytes: v.number(),
        createdAtFile: v.number(),
        modifiedAtFile: v.number(),
        quickHash: v.optional(v.string()),
        fullHash: v.optional(v.string()),
        classification: v.string(),
        riskLevel: v.string(),
        isGenerated: v.boolean(),
        isRaw: v.boolean(),
        isFinal: v.boolean(),
        isProjectFile: v.boolean(),
        projectId: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const driveIdObj = args.driveId ? ctx.db.normalizeId("drives", args.driveId) : undefined;
    const scanSessionIdObj = ctx.db.normalizeId("scanSessions", args.scanSessionId);

    let newFilesCount = 0;
    let totalBytesUploaded = 0;

    // Get all projects to try and guess projectId from folder paths if missing
    const allProjects = await ctx.db.query("projects").collect();

    for (const f of args.files) {
      totalBytesUploaded += f.sizeBytes;

      // Guess projectId from path if not explicitly passed
      let resolvedProjectId: string | undefined = f.projectId;
      if (!resolvedProjectId) {
        const pathLower = f.path.toLowerCase();
        const matchedProject = allProjects.find((p) => {
          const namePart = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
          const slugPart = p.slug.toLowerCase().replace(/[^a-z0-9]+/g, "");
          const clientPart = p.client.toLowerCase().replace(/[^a-z0-9]+/g, "");
          return (
            (namePart && pathLower.includes(namePart)) ||
            (slugPart && pathLower.includes(slugPart)) ||
            (clientPart && pathLower.includes(clientPart))
          );
        });
        if (matchedProject) {
          resolvedProjectId = matchedProject._id;
        }
      }

      // Check if file record already exists via the (driveId, path) index — a
      // point lookup regardless of catalog size. An undefined driveId is a valid
      // index key, so machine-only files dedupe among themselves, never against
      // files that belong to a known drive.
      const existing = await ctx.db
        .query("files")
        .withIndex("by_drive_path", (q) => q.eq("driveId", driveIdObj ?? args.driveId).eq("path", f.path))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          projectId: resolvedProjectId,
          sizeBytes: f.sizeBytes,
          modifiedAtFile: f.modifiedAtFile,
          lastSeenAt: timestamp,
          quickHash: f.quickHash || existing.quickHash,
          fullHash: f.fullHash || existing.fullHash,
          classification: f.classification,
          riskLevel: f.riskLevel,
          isGenerated: f.isGenerated,
          isRaw: f.isRaw,
          isFinal: f.isFinal,
          isProjectFile: f.isProjectFile,
          scanSessionId: args.scanSessionId,
        });
      } else {
        newFilesCount++;
        await ctx.db.insert("files", {
          projectId: resolvedProjectId,
          driveId: driveIdObj ?? args.driveId,
          machineId: args.machineId,
          source: "local",
          path: f.path,
          normalizedPath: f.normalizedPath,
          parentPath: f.parentPath,
          name: f.name,
          extension: f.extension,
          sizeBytes: f.sizeBytes,
          createdAtFile: f.createdAtFile,
          modifiedAtFile: f.modifiedAtFile,
          lastSeenAt: timestamp,
          quickHash: f.quickHash,
          fullHash: f.fullHash,
          classification: f.classification,
          riskLevel: f.riskLevel,
          storageTier: "hot", // Defaults to drive/local storage tier
          isGenerated: f.isGenerated,
          isRaw: f.isRaw,
          isFinal: f.isFinal,
          isProjectFile: f.isProjectFile,
          scanSessionId: args.scanSessionId,
        });
      }
    }

    // Update scanSession progress
    if (scanSessionIdObj) {
      const session = await ctx.db.get(scanSessionIdObj);
      if (session) {
        await ctx.db.patch(scanSessionIdObj, {
          filesScanned: session.filesScanned + args.files.length,
          bytesScanned: session.bytesScanned + totalBytesUploaded,
        });
      }
    }

    // Run simple post-upload hook to update drive metrics
    if (driveIdObj) {
      const drive = await ctx.db.get(driveIdObj);
      if (drive) {
        // Compute duplicates and safe cleanup totals later via separate trigger or job
        await ctx.db.patch(driveIdObj, {
          lastSeenAt: timestamp,
        });
      }
    }

    return { success: true, uploaded: args.files.length, newFiles: newFilesCount };
  },
});

// Paged, trimmed view of the file catalog for the analysis actions (duplicate
// detection, recommendations). Each page stays far below the per-transaction
// document read limit, so analysis scales to catalogs of any size.
export const pageForAnalysis = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("files")
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      files: page.page.map((f) => ({
        _id: f._id,
        path: f.path,
        name: f.name,
        sizeBytes: f.sizeBytes,
        modifiedAtFile: f.modifiedAtFile,
        quickHash: f.quickHash,
        fullHash: f.fullHash,
        storageTier: f.storageTier,
        source: f.source,
        isRaw: f.isRaw,
        isFinal: f.isFinal,
        projectId: f.projectId,
        riskLevel: f.riskLevel,
        classification: f.classification,
        deletedAt: f.deletedAt,
      })),
    };
  },
});
