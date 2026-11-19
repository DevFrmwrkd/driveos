import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireMember, inTenant } from "./access";
import { catalogFingerprintMatches, catalogKnownFingerprintMatches, catalogPathWithin, catalogReceipt, MAX_CATALOG_RECEIPTS } from "./catalogObservations";

const MIN_GENERIC_CATALOG_FILE_SIZE_BYTES = 1024 * 1024;

async function catalogScope(ctx: any, args: any, requireSession = true) {
  const tenantId = args.tenantId || "";
  const machineId = ctx.db.normalizeId("machines", args.machineId);
  const machine = machineId ? await ctx.db.get(machineId) : null;
  if (!machine || !tenantId || machine.tenantId !== tenantId) throw new ConvexError("Unknown catalog machine.");
  const driveId = args.driveId ? ctx.db.normalizeId("drives", args.driveId) : null;
  const drive = driveId ? await ctx.db.get(driveId) : null;
  if ((requireSession || args.driveId) && (!drive || drive.tenantId !== tenantId || drive.machineId !== args.machineId))
    throw new ConvexError("Unknown machine drive.");
  if (!requireSession) return { tenantId, drive, session: null };
  const sessionId = ctx.db.normalizeId("scanSessions", args.scanSessionId);
  const session = sessionId ? await ctx.db.get(sessionId) : null;
  if (!session || session.tenantId !== tenantId || session.machineId !== args.machineId ||
    session.driveId !== String(drive._id) || session.status !== "running" ||
    !catalogPathWithin(session.rootPath, drive.mountPath, true)) throw new ConvexError("Unknown active machine scan scope.");
  return { tenantId, drive, session };
}

async function dirtyCatalog(ctx: any, tenantId: string, changed: number) {
  if (!changed) return;
  const state = await ctx.db.query("analysisState").withIndex("by_tenant", (q: any) => q.eq("tenantId", tenantId)).first();
  if (state) await ctx.db.patch(state._id, { dirtyCount: state.dirtyCount + changed, catalogGeneration: (state.catalogGeneration ?? 0) + 1 });
  else await ctx.db.insert("analysisState", { tenantId, dirtyCount: changed, scheduled: false, lastRunAt: 0, catalogGeneration: 1, analyzedGeneration: 0 });
}

// Legacy approved jobs can lack a file reservation marker. Check bounded active
// machine jobs as well as those markers before acknowledging an external unlink.
async function cleanupReservations(ctx: any, tenantId: string, machineId: string) {
  const files = new Set<string>(), jobs = new Set<string>();
  for (const status of ["approved", "queued", "running"]) {
    const active = await ctx.db.query("cleanupJobs").withIndex("by_tenant_machine_status", (q: any) =>
      q.eq("tenantId", tenantId).eq("machineId", machineId).eq("status", status)).take(201);
    if (active.length > 200) return { files, jobs, overflow: true };
    for (const job of active) if (["quarantine", "restore"].includes(job.action)) {
      jobs.add(String(job._id));
      for (const fileId of job.affectedFileIds) files.add(fileId);
    }
  }
  return { files, jobs, overflow: false };
}

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
        .withIndex("by_project_active", (q) => q.eq("projectId", args.projectId).eq("deletedAt", undefined))
        .take(limit);
    }
    if (args.driveId) {
      const driveId = ctx.db.normalizeId("drives", args.driveId);
      const drive = driveId ? inTenant(await ctx.db.get(driveId), tenantId) : null;
      if (!drive) return [];
      return await ctx.db
        .query("files")
        .withIndex("by_drive_active", (q) => q.eq("driveId", args.driveId).eq("deletedAt", undefined))
        .take(limit);
    }
    if (args.classification) {
      const classification = args.classification;
      return await ctx.db
        .query("files")
        .withIndex("by_tenant_active", (q) => q.eq("tenantId", tenantId).eq("deletedAt", undefined))
        .filter((q) => q.eq(q.field("classification"), classification))
        .take(limit);
    }
    if (args.riskLevel) {
      const riskLevel = args.riskLevel;
      return await ctx.db
        .query("files")
        .withIndex("by_tenant_active", (q) => q.eq("tenantId", tenantId).eq("deletedAt", undefined))
        .filter((q) => q.eq(q.field("riskLevel"), riskLevel))
        .take(limit);
    }

    return await ctx.db
      .query("files")
      .withIndex("by_tenant_active", (q) => q.eq("tenantId", tenantId).eq("deletedAt", undefined))
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
    catalogReceiptProtocol: v.optional(v.number()),
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
        forceObservation: v.optional(v.boolean()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const timestamp = Date.now();
    const driveIdObj = args.driveId ? ctx.db.normalizeId("drives", args.driveId) : undefined;
    if (args.files.length < 1 || args.files.length > MAX_CATALOG_RECEIPTS) throw new ConvexError("Upload batches require 1 to 100 files.");
    const receiptProtocol = args.catalogReceiptProtocol === 1;
    if (args.catalogReceiptProtocol !== undefined && !receiptProtocol) throw new ConvexError("Unsupported catalog receipt protocol.");
    const scope = await catalogScope(ctx, args, receiptProtocol);
    const receipts = [];

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
      if (receiptProtocol && !catalogPathWithin(f.path, scope.session.rootPath)) throw new ConvexError("File is outside the active scan root.");
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
      if (existing && (existing.source !== "local" || (existing.machineId && existing.machineId !== args.machineId)))
        throw new ConvexError("File does not belong to this catalog machine.");

      if (existing) {
        // An unchanged quick scan keeps the stored full hash; changed content
        // invalidates it. A scan guess never CLEARS a projectId —
        // it may have been assigned manually in the dashboard.
        const nextQuickHash = f.quickHash || existing.quickHash;
        const sameContentFingerprint = existing.sizeBytes === f.sizeBytes &&
          existing.modifiedAtFile === f.modifiedAtFile &&
          (!f.quickHash || existing.quickHash === f.quickHash);
        // A quick rescan cannot vouch for the previous full checksum after a
        // content/stat change. Keeping it could classify an edited unique file
        // as an exact duplicate until a full hash is recomputed.
        const nextFullHash = f.fullHash || (sameContentFingerprint ? existing.fullHash : undefined);
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
          existing.machineId === args.machineId &&
          !existing.deletedAt;

        // Nothing material changed → write nothing. lastSeenAt intentionally
        // goes stale on unchanged rows; nothing queries it.
        if (unchanged) {
          if (receiptProtocol && f.forceObservation) {
            const observationRevision = (existing.observationRevision ?? 0) + 1;
            await ctx.db.patch(existing._id, { observationRevision });
            receipts.push(catalogReceipt({ ...existing, observationRevision }));
          } else if (receiptProtocol) receipts.push(catalogReceipt(existing));
          continue;
        }

        changedFilesCount++;
        const patch = {
          machineId: args.machineId,
          observationRevision: (existing.observationRevision ?? 0) + 1,
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
        };
        await ctx.db.patch(existing._id, patch);
        if (receiptProtocol) receipts.push(catalogReceipt({ ...existing, ...patch }));
      } else {
        newFilesCount++;
        const inserted = {
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
          observationRevision: 1,
        };
        const fileId = await ctx.db.insert("files", inserted);
        if (receiptProtocol) receipts.push(catalogReceipt({ ...inserted, _id: fileId }));
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
    await dirtyCatalog(ctx, tenantId, dirtyDelta);

    return {
      success: true,
      uploaded: args.files.length,
      newFiles: newFilesCount,
      changedFiles: changedFilesCount,
      ignoredSmallFiles: ignoredSmallFilesCount,
      ...(receiptProtocol ? { receipts } : {}),
    };
  },
});

const fingerprintFields = {
  path: v.string(), sizeBytes: v.number(), modifiedAtFile: v.number(),
  quickHash: v.optional(v.string()), fullHash: v.optional(v.string()),
};

// A legacy watcher cache knows the last acknowledged metadata but has no CAS
// token. Bootstrap only those affected paths, then require a fresh physical
// absence check on the agent before it submits the resulting receipt.
export const getCatalogReceipts = internalQuery({
  args: { scanSessionId: v.string(), machineId: v.string(), driveId: v.string(), tenantId: v.optional(v.string()),
    files: v.array(v.object(fingerprintFields)) },
  handler: async (ctx, args) => {
    if (args.files.length < 1 || args.files.length > MAX_CATALOG_RECEIPTS) throw new ConvexError("Receipt lookup requires 1 to 100 files.");
    const { tenantId, session } = await catalogScope(ctx, args);
    const reservations = await cleanupReservations(ctx, tenantId, args.machineId);
    const receipts = [], rejected = [];
    for (const expected of args.files) {
      if (!catalogPathWithin(expected.path, session.rootPath)) {
        rejected.push({ path: expected.path, status: "conflict" }); continue;
      }
      const file = await ctx.db.query("files").withIndex("by_drive_path", q => q.eq("driveId", args.driveId).eq("path", expected.path)).first();
      if (!file || file.tenantId !== tenantId || file.machineId !== args.machineId || file.source !== "local") {
        rejected.push({ path: expected.path, status: "not_found" }); continue;
      }
      if (reservations.overflow || reservations.files.has(String(file._id)) ||
        (file.pendingCleanupJobId && reservations.jobs.has(file.pendingCleanupJobId))) {
        rejected.push({ path: expected.path, status: "deferred" }); continue;
      }
      if (!catalogKnownFingerprintMatches(file, expected)) {
        rejected.push({ path: expected.path, status: "conflict" }); continue;
      }
      receipts.push(catalogReceipt(file));
    }
    return { success: true, receipts, rejected };
  },
});

// Catalog-only deletion receipts never move files, modify quarantine records,
// or release cleanup reservations. The authenticated machine is the only
// authority for its own drive and active watched scan root.
export const reportMissingFiles = internalMutation({
  args: { scanSessionId: v.string(), machineId: v.string(), driveId: v.string(), tenantId: v.optional(v.string()),
    files: v.array(v.object({ ...fingerprintFields, fileId: v.string(), catalogVersion: v.number(),
      driveId: v.optional(v.string()), machineId: v.optional(v.string()) })) },
  handler: async (ctx, args) => {
    if (args.files.length < 1 || args.files.length > MAX_CATALOG_RECEIPTS) throw new ConvexError("Deletion receipts require 1 to 100 files.");
    const { tenantId, session } = await catalogScope(ctx, args);
    const reservations = await cleanupReservations(ctx, tenantId, args.machineId);
    const receipts = [];
    let deleted = 0;
    for (const expected of args.files) {
      if (!Number.isSafeInteger(expected.catalogVersion) || expected.catalogVersion < 0 || !catalogPathWithin(expected.path, session.rootPath) ||
        (expected.driveId !== undefined && expected.driveId !== args.driveId) ||
        (expected.machineId !== undefined && expected.machineId !== args.machineId)) {
        receipts.push({ path: expected.path, status: "conflict" }); continue;
      }
      const id = ctx.db.normalizeId("files", expected.fileId);
      const file = id ? await ctx.db.get(id) : null;
      if (!file || file.tenantId !== tenantId || file.machineId !== args.machineId ||
        file.driveId !== args.driveId || file.path !== expected.path || file.source !== "local") {
        receipts.push({ path: expected.path, status: "not_found" }); continue;
      }
      if (reservations.overflow || reservations.files.has(String(file._id)) ||
        (file.pendingCleanupJobId && reservations.jobs.has(file.pendingCleanupJobId))) {
        receipts.push({ path: expected.path, status: "deferred" }); continue;
      }
      if (file.deletedAt !== undefined) {
        receipts.push({ path: expected.path, status: "already_deleted" }); continue;
      }
      if ((file.observationRevision ?? 0) !== expected.catalogVersion || !catalogFingerprintMatches(file, expected)) {
        receipts.push({ path: expected.path, status: "conflict" }); continue;
      }
      await ctx.db.patch(file._id, { deletedAt: Date.now(), observationRevision: (file.observationRevision ?? 0) + 1 });
      deleted++;
      receipts.push({ path: expected.path, status: "deleted" });
    }
    await dirtyCatalog(ctx, tenantId, deleted);
    return { success: true, receipts };
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
      .withIndex("by_tenant_active", (q) => q.eq("tenantId", args.tenantId).eq("deletedAt", undefined))
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
