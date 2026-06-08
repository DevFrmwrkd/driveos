import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./access";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("duplicateClusters").collect();
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

export const runDuplicateDetection = mutation({
  args: {},
  handler: async (ctx) => {
    // 1) Fetch all files larger than 1 MB that have hashes
    const allFiles = await ctx.db.query("files").collect();

    // Group files by fullHash
    const exactGroups: Record<string, typeof allFiles> = {};
    const likelyGroups: Record<string, typeof allFiles> = {};

    for (const f of allFiles) {
      if (f.fullHash) {
        if (!exactGroups[f.fullHash]) exactGroups[f.fullHash] = [];
        exactGroups[f.fullHash].push(f);
      } else if (f.quickHash) {
        if (!likelyGroups[f.quickHash]) likelyGroups[f.quickHash] = [];
        likelyGroups[f.quickHash].push(f);
      }
    }

    const timestamp = Date.now();

    // Helper to evaluate trust score of a file
    const getTrustScore = (file: typeof allFiles[0]) => {
      let score = 0;
      if (file.storageTier === "cold") score += 100; // archive drives are trusted
      if (file.source === "cloud") score += 80;     // cloud copy is highly trusted
      if (file.isRaw && file.path.includes("/RAW/")) score += 60; // RAW folder is trusted
      if (file.isFinal) score += 50;                // Final deliverables are trusted
      score += file.modifiedAtFile * 0.0000000001;  // Tie breaker: prefer newer edits
      return score;
    };

    // 2) Process Exact Duplicates (fullHash)
    for (const [hash, files] of Object.entries(exactGroups)) {
      if (files.length <= 1) continue;

      // Sort files by trust score descending
      files.sort((a, b) => getTrustScore(b) - getTrustScore(a));

      const keepFile = files[0];
      const sizeBytes = keepFile.sizeBytes;
      const totalBytes = sizeBytes * files.length;
      const wastedBytes = sizeBytes * (files.length - 1);
      const fileIds = files.map((f) => f._id);
      const projectIdsSet = new Set(files.map((f) => f.projectId).filter(Boolean) as string[]);
      const projectIds = Array.from(projectIdsSet);

      // Check if cluster already exists for this hash
      const existing = await ctx.db
        .query("duplicateClusters")
        .filter((q) => q.eq(q.field("hashKey"), hash))
        .first();

      const explanation = `Found ${files.length} exact duplicates of "${keepFile.name}" across different locations. Wasting ${(wastedBytes / (1024 ** 3)).toFixed(1)} GB. Keep recommended: "${keepFile.path}"`;

      if (existing) {
        await ctx.db.patch(existing._id, {
          fileIds,
          projectIds,
          totalBytes,
          wastedBytes,
          fileCount: files.length,
          recommendedKeepFileId: keepFile._id,
          explanation,
          updatedAt: timestamp,
        });
      } else {
        await ctx.db.insert("duplicateClusters", {
          type: "exact",
          hashKey: hash,
          fileIds,
          projectIds,
          totalBytes,
          wastedBytes,
          fileCount: files.length,
          recommendedKeepFileId: keepFile._id,
          riskLevel: keepFile.riskLevel,
          explanation,
          status: "open",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }

    // 3) Process Likely Duplicates (quickHash)
    for (const [hash, files] of Object.entries(likelyGroups)) {
      if (files.length <= 1) continue;

      files.sort((a, b) => getTrustScore(b) - getTrustScore(a));

      const keepFile = files[0];
      const sizeBytes = keepFile.sizeBytes;
      const totalBytes = sizeBytes * files.length;
      const wastedBytes = sizeBytes * (files.length - 1);
      const fileIds = files.map((f) => f._id);
      const projectIdsSet = new Set(files.map((f) => f.projectId).filter(Boolean) as string[]);
      const projectIds = Array.from(projectIdsSet);

      const existing = await ctx.db
        .query("duplicateClusters")
        .filter((q) => q.eq(q.field("hashKey"), hash))
        .first();

      const explanation = `Found ${files.length} likely duplicates of "${keepFile.name}" based on quick hashing. Needs review.`;

      if (existing) {
        await ctx.db.patch(existing._id, {
          fileIds,
          projectIds,
          totalBytes,
          wastedBytes,
          fileCount: files.length,
          recommendedKeepFileId: keepFile._id,
          explanation,
          updatedAt: timestamp,
        });
      } else {
        await ctx.db.insert("duplicateClusters", {
          type: "likely",
          hashKey: hash,
          fileIds,
          projectIds,
          totalBytes,
          wastedBytes,
          fileCount: files.length,
          recommendedKeepFileId: keepFile._id,
          riskLevel: "yellow",
          explanation,
          status: "open",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }

    return { success: true };
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
