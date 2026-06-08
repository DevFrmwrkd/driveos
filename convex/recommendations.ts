import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("recommendations").collect();
  },
});

export const get = query({
  args: { recommendationId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("recommendations", args.recommendationId);
    if (!id) return null;
    return await ctx.db.get(id);
  },
});

export const generateRecommendations = mutation({
  args: {},
  handler: async (ctx) => {
    const timestamp = Date.now();

    // 1) Fetch all files, projects, drives, and duplicates to base recommendations on
    const allFiles = await ctx.db.query("files").collect();
    const allProjects = await ctx.db.query("projects").collect();
    const allDrives = await ctx.db.query("drives").collect();
    const duplicateClusters = await ctx.db.query("duplicateClusters").collect();

    // Group files by projectId and classification
    const cacheFiles = allFiles.filter((f) => f.classification === "CACHE" || f.classification === "RENDER_PREVIEW");
    const proxyFiles = allFiles.filter((f) => f.classification === "PROXY");
    const exportReviewFiles = allFiles.filter((f) => f.classification === "EXPORT_REVIEW");

    // Clear open recommendations to regenerate freshly
    const openRecommendations = await ctx.db
      .query("recommendations")
      .filter((q) => q.eq(q.field("status"), "open"))
      .collect();

    for (const rec of openRecommendations) {
      await ctx.db.delete(rec._id);
    }

    // --- RECOMMENDED ACTIONS GENERATION ---

    // A) Recommendation: Clean Cache & Renders (Safe Cleanup)
    if (cacheFiles.length > 0) {
      const cacheBytes = cacheFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
      const cacheFileIds = cacheFiles.map((f) => f._id);
      const affectedProjectsSet = new Set(cacheFiles.map((f) => f.projectId).filter(Boolean) as string[]);

      await ctx.db.insert("recommendations", {
        type: "delete_cache",
        title: "Premiere & DaVinci cache",
        explanation: `Regenerable cache and peak files from video editing. These files can be safely deleted and will rebuild automatically when you reopen the active projects. This will immediately free up ${(cacheBytes / (1024 ** 4)).toFixed(2)} TB.`,
        affectedFileIds: cacheFileIds,
        affectedBytes: cacheBytes,
        riskLevel: "green",
        confidence: 1.0,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    // B) Recommendation: Clean Proxies for Delivered Projects (Safe Cleanup)
    const deliveredProjects = allProjects.filter((p) => p.status === "delivered" || p.status === "archived");
    const deliveredProjectIds = deliveredProjects.map((p) => String(p._id));
    const deliveredProxies = proxyFiles.filter((f) => f.projectId && deliveredProjectIds.includes(f.projectId));

    if (deliveredProxies.length > 0) {
      const proxyBytes = deliveredProxies.reduce((acc, f) => acc + f.sizeBytes, 0);
      const proxyFileIds = deliveredProxies.map((f) => f._id);

      await ctx.db.insert("recommendations", {
        type: "delete_proxies",
        title: "Proxies of delivered projects",
        explanation: `Generated proxy files for projects already completed and delivered. The camera RAW footage remains safely indexed and archived, so these temporary edit proxies are no longer needed. Clears ${(proxyBytes / (1024 ** 3)).toFixed(1)} GB.`,
        affectedFileIds: proxyFileIds,
        affectedBytes: proxyBytes,
        riskLevel: "green",
        confidence: 0.95,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    // C) Recommendation: Remove Exact Duplicates (Safe/Review)
    const openClusters = duplicateClusters.filter((c) => c.status === "open" && c.type === "exact");
    if (openClusters.length > 0) {
      const totalWastedBytes = openClusters.reduce((acc, c) => acc + c.wastedBytes, 0);
      const duplicateFileIds: string[] = [];
      for (const cluster of openClusters) {
        // Collect files recommended for quarantine (the ones that are not the keep copy)
        const keepId = cluster.recommendedKeepFileId;
        const dupIds = cluster.fileIds.filter((id) => id !== keepId);
        duplicateFileIds.push(...dupIds);
      }

      if (duplicateFileIds.length > 0) {
        await ctx.db.insert("recommendations", {
          type: "remove_duplicate",
          title: "Remove exact duplicate media files",
          explanation: `Identical video clips and raw files copied multiple times across projects and drives. Deleting redundant copies and keeping the reference master will safely recover ${(totalWastedBytes / (1024 ** 4)).toFixed(2)} TB.`,
          affectedFileIds: duplicateFileIds,
          affectedBytes: totalWastedBytes,
          riskLevel: "green",
          confidence: 0.98,
          status: "open",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }

    // D) Recommendation: Move Delivered Projects from Hot to Warm Storage (Staging)
    const hotDeliveredProjects = deliveredProjects.filter((p) => p.tier === "hot" && p.status === "delivered");
    for (const project of hotDeliveredProjects) {
      const projectFiles = allFiles.filter((f) => f.projectId === project._id);
      const projectBytes = projectFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
      const fileIds = projectFiles.map((f) => f._id);

      await ctx.db.insert("recommendations", {
        type: "move_to_warm",
        title: `Staging: Move completed "${project.name}" to Warm`,
        explanation: `Project "${project.name}" was marked as completed/delivered, but is currently sitting on your fast, active editing SSDs. Moving it to nearline storage preserves it while freeing up local workspace.`,
        projectId: project._id,
        affectedFileIds: fileIds,
        affectedBytes: projectBytes,
        riskLevel: "green",
        confidence: 0.9,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    // E) Recommendation: Archive Completed Projects to Cold Storage (Archive)
    const readyDeliveredProjects = deliveredProjects.filter((p) => p.status === "delivered" && p.storageHealthScore >= 80);
    for (const project of readyDeliveredProjects) {
      const projectFiles = allFiles.filter((f) => f.projectId === project._id);
      const projectBytes = projectFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
      const fileIds = projectFiles.map((f) => f._id);

      await ctx.db.insert("recommendations", {
        type: "archive_project",
        title: `Archive: Cold archive "${project.name}"`,
        explanation: `Project "${project.name}" is fully delivered and has a storage health score of ${project.storageHealthScore}%. It is ready to be written to cold offline archive drives and marked complete.`,
        projectId: project._id,
        affectedFileIds: fileIds,
        affectedBytes: projectBytes,
        riskLevel: "yellow",
        confidence: 0.85,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    // F) Recommendation: Backup final exports to the cloud (Sync)
    const activeProjects = allProjects.filter((p) => p.status === "active" || p.status === "review");
    for (const project of activeProjects) {
      const finalExports = allFiles.filter((f) => f.projectId === project._id && f.classification === "EXPORT_FINAL");
      // Check if any of these final exports exist in cloud
      const cloudFinals = allFiles.filter((f) => f.projectId === project._id && f.classification === "EXPORT_FINAL" && f.source === "cloud");

      if (finalExports.length > 0 && cloudFinals.length === 0) {
        const localFinals = finalExports.filter((f) => f.source === "local");
        const finalBytes = localFinals.reduce((acc, f) => acc + f.sizeBytes, 0);
        const fileIds = localFinals.map((f) => f._id);

        await ctx.db.insert("recommendations", {
          type: "copy_to_cloud",
          title: `Backup final exports of "${project.name}" to Cloud`,
          explanation: `Project "${project.name}" final exports do not exist on Google Drive. Uploading these masters ensures safe collaborative reviews and client handoffs.`,
          projectId: project._id,
          affectedFileIds: fileIds,
          affectedBytes: finalBytes,
          riskLevel: "yellow",
          confidence: 0.9,
          status: "open",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }

    return { success: true, count: openRecommendations.length };
  },
});

export const updateStatus = mutation({
  args: {
    recommendationId: v.string(),
    status: v.string(), // "open" | "approved" | "ignored" | "completed" | "failed"
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("recommendations", args.recommendationId);
    if (!id) return;
    await ctx.db.patch(id, {
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});
