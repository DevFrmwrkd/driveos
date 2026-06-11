import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember } from "./access";

// Mirrors the agent-side protection list: these classifications are never auto-quarantined.
const PROTECTED_CLASSIFICATIONS = new Set(["RAW", "EXPORT_FINAL", "PROJECT_FILE", "ADMIN", "ARCHIVE_MANIFEST"]);

export const list = query({
  args: {},
  handler: async (ctx) => {
    // Only open clusters appear in the Duplicate Center; ignored, resolved and
    // quarantined ones drop out of the list (and the dashboard totals) live.
    // Indexed + capped: Convex limits a query to 4096 reads, so fetch the top
    // clusters by wasted bytes and resolve a bounded number of files per
    // cluster — an uncapped version crashed once real catalogs grew.
    const clusters = await ctx.db
      .query("duplicateClusters")
      .withIndex("by_status_wasted", (q) => q.eq("status", "open"))
      .order("desc")
      .take(100);
    const machineNames = new Map<string, string>();

    const enriched = [];
    for (const cluster of clusters) {
      const locations = [];
      // Cap resolved copies per cluster; fileCount still reports the true total.
      // A >20-copy quarantine processes the listed copies now and the rest
      // re-surface on the next detection pass.
      for (const fId of cluster.fileIds.slice(0, 20)) {
        const fileId = ctx.db.normalizeId("files", fId);
        if (!fileId) continue;
        const file = await ctx.db.get(fileId);
        if (!file || file.deletedAt) continue;

        let drive = file.driveId || "";
        if (!drive && file.machineId) {
          if (!machineNames.has(file.machineId)) {
            const machineId = ctx.db.normalizeId("machines", file.machineId);
            const machine = machineId ? await ctx.db.get(machineId) : null;
            machineNames.set(file.machineId, machine?.name || "Local machine");
          }
          drive = machineNames.get(file.machineId)!;
        }
        if (!drive) drive = file.source === "cloud" ? "Cloud" : "Local";

        const isKeep = file._id === cluster.recommendedKeepFileId;
        const isProtected = PROTECTED_CLASSIFICATIONS.has(file.classification);
        const role = isKeep ? "keep" : isProtected || cluster.type !== "exact" ? "review" : "quarantine";

        locations.push({
          fileId: file._id,
          path: file.path,
          drive,
          role,
          tag: isKeep ? "Recommended keep" : isProtected ? "Protected " + file.classification : file.classification,
          sizeBytes: file.sizeBytes,
        });
      }
      enriched.push({ ...cluster, locations });
    }
    return enriched;
  },
});

export const getCluster = query({
  args: { clusterId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("duplicateClusters", args.clusterId);
    if (!id) return null;
    const cluster = await ctx.db.get(id);
    if (!cluster) return null;

    // Resolve details of duplicate files
    const resolvedFiles = [];
    for (const fId of cluster.fileIds) {
      const fileIdObj = ctx.db.normalizeId("files", fId);
      if (fileIdObj) {
        const file = await ctx.db.get(fileIdObj);
        if (file) {
          resolvedFiles.push(file);
        }
      }
    }

    return { ...cluster, files: resolvedFiles };
  },
});

// Trimmed file record the detection action accumulates in memory.
interface AnalysisFile {
  _id: string;
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAtFile: number;
  quickHash?: string;
  fullHash?: string;
  storageTier: string;
  source: string;
  isRaw: boolean;
  isFinal: boolean;
  projectId?: string;
  riskLevel: string;
  deletedAt?: number;
}

// Helper to evaluate trust score of a file
function getTrustScore(file: AnalysisFile) {
  let score = 0;
  if (file.storageTier === "cold") score += 100; // archive drives are trusted
  if (file.source === "cloud") score += 80;     // cloud copy is highly trusted
  if (file.isRaw && file.path.includes("/RAW/")) score += 60; // RAW folder is trusted
  if (file.isFinal) score += 50;                // Final deliverables are trusted
  score += file.modifiedAtFile * 0.0000000001;  // Tie breaker: prefer newer edits
  return score;
}

function buildCluster(type: "exact" | "likely", hash: string, files: AnalysisFile[]) {
  files.sort((a, b) => getTrustScore(b) - getTrustScore(a));
  const keepFile = files[0];
  const sizeBytes = keepFile.sizeBytes;
  const wastedBytes = sizeBytes * (files.length - 1);
  const explanation = type === "exact"
    ? `Found ${files.length} exact duplicates of "${keepFile.name}" across different locations. Wasting ${(wastedBytes / (1024 ** 3)).toFixed(1)} GB. Keep recommended: "${keepFile.path}"`
    : `Found ${files.length} likely duplicates of "${keepFile.name}" based on quick hashing. Needs review.`;
  return {
    type,
    hashKey: hash,
    fileIds: files.map((f) => f._id),
    projectIds: Array.from(new Set(files.map((f) => f.projectId).filter(Boolean) as string[])),
    totalBytes: sizeBytes * files.length,
    wastedBytes,
    fileCount: files.length,
    recommendedKeepFileId: keepFile._id,
    riskLevel: type === "exact" ? keepFile.riskLevel : "yellow",
    explanation,
  };
}

// Detection is an action so the file catalog can be read in pages — a single
// mutation hits Convex's per-transaction read limit once the catalog grows past
// a few thousand files. The action accumulates hash groups in memory, then
// writes clusters through small batched mutations.
export const runDuplicateDetection = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; clusterCount: number }> => {
    const exactGroups = new Map<string, AnalysisFile[]>();
    const likelyGroups = new Map<string, AnalysisFile[]>();

    let cursor: string | null = null;
    while (true) {
      const page: any = await ctx.runQuery(internal.files.pageForAnalysis, { cursor, numItems: 1000 });
      for (const f of page.files as AnalysisFile[]) {
        if (f.deletedAt) continue; // quarantined/soft-deleted files never re-cluster
        if (f.fullHash) {
          const group = exactGroups.get(f.fullHash) || [];
          group.push(f);
          exactGroups.set(f.fullHash, group);
        } else if (f.quickHash) {
          const group = likelyGroups.get(f.quickHash) || [];
          group.push(f);
          likelyGroups.set(f.quickHash, group);
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    const clusters = [];
    for (const [hash, files] of exactGroups) {
      if (files.length > 1) clusters.push(buildCluster("exact", hash, files));
    }
    for (const [hash, files] of likelyGroups) {
      if (files.length > 1) clusters.push(buildCluster("likely", hash, files));
    }

    // Upsert in small batches so each mutation stays well under transaction limits.
    const timestamp = Date.now();
    for (let i = 0; i < clusters.length; i += 50) {
      await ctx.runMutation(internal.duplicates.upsertClusters, {
        clusters: clusters.slice(i, i + 50),
        timestamp,
      });
    }

    // Drop clusters whose hash no longer maps to duplicates — files were
    // deleted, quarantined, or their drive was removed. Without this, stale
    // clusters from old scans linger in the Duplicate Center forever. Paged
    // like the file walk so it scales to any cluster count.
    const validHashKeys = new Set(clusters.map((c) => c.hashKey));
    const staleIds: string[] = [];
    let clusterCursor: string | null = null;
    while (true) {
      const page: any = await ctx.runQuery(internal.duplicates.pageClusterKeys, {
        cursor: clusterCursor,
        numItems: 1000,
      });
      for (const c of page.clusters) {
        if (!validHashKeys.has(c.hashKey)) staleIds.push(c._id);
      }
      if (page.isDone) break;
      clusterCursor = page.continueCursor;
    }
    for (let i = 0; i < staleIds.length; i += 200) {
      await ctx.runMutation(internal.duplicates.deleteClusters, { clusterIds: staleIds.slice(i, i + 200) });
    }

    return { success: true, clusterCount: clusters.length };
  },
});

export const pageClusterKeys = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("duplicateClusters")
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      clusters: page.page.map((c) => ({ _id: c._id, hashKey: c.hashKey })),
    };
  },
});

export const deleteClusters = internalMutation({
  args: { clusterIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    for (const clusterId of args.clusterIds) {
      const id = ctx.db.normalizeId("duplicateClusters", clusterId);
      if (id) await ctx.db.delete(id);
    }
  },
});

export const upsertClusters = internalMutation({
  args: {
    timestamp: v.number(),
    clusters: v.array(
      v.object({
        type: v.string(),
        hashKey: v.string(),
        fileIds: v.array(v.string()),
        projectIds: v.array(v.string()),
        totalBytes: v.number(),
        wastedBytes: v.number(),
        fileCount: v.number(),
        recommendedKeepFileId: v.string(),
        riskLevel: v.string(),
        explanation: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const cluster of args.clusters) {
      const existing = await ctx.db
        .query("duplicateClusters")
        .withIndex("by_hashKey", (q) => q.eq("hashKey", cluster.hashKey))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          fileIds: cluster.fileIds,
          projectIds: cluster.projectIds,
          totalBytes: cluster.totalBytes,
          wastedBytes: cluster.wastedBytes,
          fileCount: cluster.fileCount,
          recommendedKeepFileId: cluster.recommendedKeepFileId,
          explanation: cluster.explanation,
          updatedAt: args.timestamp,
        });
      } else {
        await ctx.db.insert("duplicateClusters", {
          ...cluster,
          status: "open",
          createdAt: args.timestamp,
          updatedAt: args.timestamp,
        });
      }
    }
  },
});

export const updateStatus = mutation({
  args: {
    clusterId: v.string(),
    status: v.string(), // "open" | "ignored" | "quarantined" | "resolved"
  },
  handler: async (ctx, args) => {
    await requireMember(ctx);
    const id = ctx.db.normalizeId("duplicateClusters", args.clusterId);
    if (!id) return;
    await ctx.db.patch(id, {
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});
