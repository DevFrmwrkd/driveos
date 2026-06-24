import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireMember, inTenant } from "./access";

export const list = query({
  args: {
    limit: v.optional(v.number()),
    driveId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    classification: v.optional(v.string()),
    riskLevel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const limit = args.limit || 50;

    if (args.projectId) {
      // A tenant's project owns only that tenant's files. Verify ownership first.
      const projectId = ctx.db.normalizeId("projects", args.projectId);
      const project = projectId ? inTenant(await ctx.db.get(projectId), tenantId) : null;
      if (!project) return [];
      return await ctx.db
        .query("files")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(limit);
    }
    if (args.driveId) {
      const driveId = ctx.db.normalizeId("drives", args.driveId);
      const drive = driveId ? inTenant(await ctx.db.get(driveId), tenantId) : null;
      if (!drive) return [];
      return await ctx.db
        .query("files")
        .withIndex("by_drive", (q) => q.eq("driveId", args.driveId))
        .take(limit);
    }
    if (args.classification) {
      const classification = args.classification;
      return await ctx.db
        .query("files")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
        .filter((q) => q.eq(q.field("classification"), classification))
        .take(limit);
    }
    if (args.riskLevel) {
      const riskLevel = args.riskLevel;
      return await ctx.db
        .query("files")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
        .filter((q) => q.eq(q.field("riskLevel"), riskLevel))
        .take(limit);
    }

    return await ctx.db
      .query("files")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .take(limit);
  },
});

export const getByHash = query({
  args: { fullHash: v.string() },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("files")
      .withIndex("by_tenant_fullHash", (q) =>
        q.eq("tenantId", tenantId).eq("fullHash", args.fullHash)
      )
      .collect();
  },
});

// Agent-only (internal): bulk-upsert scanned file metadata into the agent's
// tenant. Reached solely via the token-authenticated HTTP route.
export const uploadBatch = internalMutation({
  args: {
    scanSessionId: v.string(),
    machineId: v.string(),
    driveId: v.optional(v.string()),
    tenantId: v.optional(v.string()),
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
    const tenantId = args.tenantId || "";
    const timestamp = Date.now();
    const driveIdObj = args.driveId ? ctx.db.normalizeId("drives", args.driveId) : undefined;
    const scanSessionIdObj = ctx.db.normalizeId("scanSessions", args.scanSessionId);

    let newFilesCount = 0;
    let totalBytesUploaded = 0;

    // Only this tenant's projects can match for projectId guessing.
    const allProjects = await ctx.db
      .query("projects")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();

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

      // Existing-file lookup via the (driveId, path) index — a point lookup
      // regardless of catalog size. For machine-only files (no driveId) the path
      // could collide across tenants, so reject a match from another tenant.
      const existingRaw = await ctx.db
        .query("files")
        .withIndex("by_drive_path", (q) => q.eq("driveId", driveIdObj ?? args.driveId).eq("path", f.path))
        .first();
      const existing = existingRaw && existingRaw.tenantId === tenantId ? existingRaw : null;

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
          tenantId,
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

    // Update scanSession progress (only if it belongs to this tenant — the id
    // arrives in the request body and must never let one tenant touch another's).
    if (scanSessionIdObj) {
      const session = await ctx.db.get(scanSessionIdObj);
      if (session && session.tenantId === tenantId) {
        await ctx.db.patch(scanSessionIdObj, {
          filesScanned: session.filesScanned + args.files.length,
          bytesScanned: session.bytesScanned + totalBytesUploaded,
        });
      }
    }

    // Run simple post-upload hook to update drive metrics (same tenant guard).
    if (driveIdObj) {
      const drive = await ctx.db.get(driveIdObj);
      if (drive && drive.tenantId === tenantId) {
        await ctx.db.patch(driveIdObj, {
          lastSeenAt: timestamp,
        });
      }
    }

    return { success: true, uploaded: args.files.length, newFiles: newFilesCount };
  },
});

// Paged, trimmed view of ONE tenant's file catalog for the analysis actions
// (duplicate detection, recommendations). Each page stays far below the
// per-transaction document read limit, so analysis scales to any catalog size.
export const pageForAnalysis = internalQuery({
  args: { tenantId: v.string(), cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("files")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
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
