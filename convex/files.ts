import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireMember, inTenant } from "./access";

const MIN_GENERIC_CATALOG_FILE_SIZE_BYTES = 1024 * 1024;
const AUTO_ANALYSIS_ENABLED = process.env.DRIVEOS_AUTO_ANALYSIS === "true";

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
        .withIndex("by_drive_path", (q) => q.eq("driveId", args.driveId))
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

// Agent-only (internal): bulk-upsert scanned file metadata into the agent's
// tenant. Reached solely via the token-authenticated HTTP route.
//
// Bandwidth contract: this mutation must write NOTHING for a file whose
// metadata is unchanged. The agent already delta-syncs (only changed files are
// sent), but older agents re-send the whole catalog every hour — blindly
// patching every row burned ~70 GB/week of write bandwidth, so the no-op check
// stays here as the backstop.
export const uploadBatch = internalMutation({
  args: {
    scanSessionId: v.string(),
    machineId: v.string(),
    driveId: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    files: v.array(
      v.object({
        path: v.string(),
        // Legacy fields still sent by pre-1.1 agents; accepted but not stored.
        normalizedPath: v.optional(v.string()),
        parentPath: v.optional(v.string()),
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

    let newFilesCount = 0;
    let changedFilesCount = 0;
    let ignoredSmallFilesCount = 0;

    // Only this tenant's projects can match for projectId guessing. Loaded
    // lazily: a batch of already-assigned files never touches the table.
    let allProjects: any[] | null = null;
    const loadProjects = async () => {
      if (allProjects === null) {
        allProjects = await ctx.db
          .query("projects")
          .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
          .collect();
      }
      return allProjects;
    };

    for (const f of args.files) {
      // Backstop for pre-1.1 agents and legacy configs: do not create one
      // database document per cache crumb/sidecar. Small project files remain
      // eligible because they are product-critical and relatively rare.
      if (f.sizeBytes < MIN_GENERIC_CATALOG_FILE_SIZE_BYTES && !f.isProjectFile) {
        ignoredSmallFilesCount++;
        continue;
      }

      // Guess projectId from path if not explicitly passed
      let resolvedProjectId: string | undefined = f.projectId;
      if (!resolvedProjectId) {
        const pathLower = f.path.toLowerCase();
        const matchedProject = (await loadProjects()).find((p) => {
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
        // A missing incoming hash keeps the stored one (quick scans don't
        // recompute full hashes), and a scan guess never CLEARS a projectId —
        // it may have been assigned manually in the dashboard.
        const nextQuickHash = f.quickHash || existing.quickHash;
        const nextFullHash = f.fullHash || existing.fullHash;
        const nextProjectId = resolvedProjectId ?? existing.projectId;

        const unchanged =
          existing.sizeBytes === f.sizeBytes &&
          existing.modifiedAtFile === f.modifiedAtFile &&
          existing.quickHash === nextQuickHash &&
          existing.fullHash === nextFullHash &&
          existing.projectId === nextProjectId &&
          existing.classification === f.classification &&
          existing.riskLevel === f.riskLevel &&
          existing.isGenerated === f.isGenerated &&
          existing.isRaw === f.isRaw &&
          existing.isFinal === f.isFinal &&
          existing.isProjectFile === f.isProjectFile &&
          !existing.deletedAt;

        // Nothing material changed → write nothing. lastSeenAt intentionally
        // goes stale on unchanged rows; nothing queries it.
        if (unchanged) continue;

        changedFilesCount++;
        await ctx.db.patch(existing._id, {
          projectId: nextProjectId,
          sizeBytes: f.sizeBytes,
          modifiedAtFile: f.modifiedAtFile,
          lastSeenAt: timestamp,
          quickHash: nextQuickHash,
          fullHash: nextFullHash,
          classification: f.classification,
          riskLevel: f.riskLevel,
          isGenerated: f.isGenerated,
          isRaw: f.isRaw,
          isFinal: f.isFinal,
          isProjectFile: f.isProjectFile,
          // Opportunistically compact legacy rows whenever they genuinely
          // change; setting optional fields to undefined removes them.
          normalizedPath: undefined,
          parentPath: undefined,
          scanSessionId: undefined,
          // A re-appearing file that was quarantined/soft-deleted is back on disk.
          deletedAt: undefined,
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
        });
      }
    }

    // Per-batch scanSession progress writes are deliberately gone. They changed
    // the same session document after every 100 files, invalidating scans.list
    // subscriptions hundreds of thousands of times. Agent 1.1 reports the true
    // totals once in completeScan; older agents show zero progress until update.

    // NOTE: the per-batch drive lastSeenAt patch is gone — scans.complete
    // already stamps the drive once per scan, and the per-batch version
    // invalidated the dashboard's reactive drives.list on every single batch.

    // Real changes make the tenant's catalog dirty, which is what arms the
    // (debounced) post-scan analysis. Unchanged re-uploads never arm it.
    const dirtyDelta = newFilesCount + changedFilesCount;
    if (AUTO_ANALYSIS_ENABLED && dirtyDelta > 0) {
      const state = await ctx.db
        .query("analysisState")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
        .first();
      if (state) {
        await ctx.db.patch(state._id, { dirtyCount: state.dirtyCount + dirtyDelta });
      } else {
        await ctx.db.insert("analysisState", {
          tenantId,
          dirtyCount: dirtyDelta,
          scheduled: false,
          lastRunAt: 0,
        });
      }
    }

    return {
      success: true,
      uploaded: args.files.length,
      newFiles: newFilesCount,
      changedFiles: changedFilesCount,
      ignoredSmallFiles: ignoredSmallFilesCount,
    };
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
