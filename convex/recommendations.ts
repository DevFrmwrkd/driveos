import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember, inTenant } from "./access";

// Cleanup screen recommendations. Only "open" recommendations belong here — once
// a recommendation has been acted on (a cleanup job was created/approved/run) it
// must drop off the list, otherwise a file the user already quarantined keeps
// reappearing on the Cleanup page. Terminal/in-flight statuses are excluded;
// anything else (pending/new/undefined) is still actionable and shown.
const HIDDEN_REC_STATUSES = new Set([
  "approved",
  "completed",
  "dismissed",
  "ignored",
  "quarantined",
]);

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    const all = await ctx.db
      .query("recommendations")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
    return all.filter((r) => !HIDDEN_REC_STATUSES.has(r.status));
  },
});

export const get = query({
  args: { recommendationId: v.string() },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const id = ctx.db.normalizeId("recommendations", args.recommendationId);
    if (!id) return null;
    return inTenant(await ctx.db.get(id), tenantId);
  },
});

// Convex documents cap at ~1 MB, so affectedFileIds is truncated for huge
// recommendations. affectedBytes always reflects the full set; cleanup jobs for
// capped recommendations process the listed files (recommendations regenerate
// after every scan, so the remainder surfaces on the next pass).
const MAX_REC_FILE_IDS = 4000;

interface FileAggregate {
  fileIds: string[];
  totalBytes: number;
  count: number;
}

function newAggregate(): FileAggregate {
  return { fileIds: [], totalBytes: 0, count: 0 };
}

function addToAggregate(agg: FileAggregate, fileId: string, sizeBytes: number) {
  if (agg.fileIds.length < MAX_REC_FILE_IDS) agg.fileIds.push(fileId);
  agg.totalBytes += sizeBytes;
  agg.count++;
}

// Generation runs per tenant (internal): page that tenant's catalog, reduce to
// per-category/per-project aggregates, then write through one small mutation.
export const generateRecommendations = internalAction({
  args: { tenantId: v.string() },
  handler: async (ctx, args): Promise<{ success: boolean; count: number }> => {
    const timestamp = Date.now();

    const cache = newAggregate();
    const proxiesByProject = new Map<string, FileAggregate>();
    const filesByProject = new Map<string, FileAggregate>();
    const localFinalsByProject = new Map<string, FileAggregate>();
    const cloudFinalCountByProject = new Map<string, number>();

    const byProject = (map: Map<string, FileAggregate>, projectId: string) => {
      let agg = map.get(projectId);
      if (!agg) {
        agg = newAggregate();
        map.set(projectId, agg);
      }
      return agg;
    };

    let cursor: string | null = null;
    while (true) {
      const page: any = await ctx.runQuery(internal.files.pageForAnalysis, {
        tenantId: args.tenantId,
        cursor,
        numItems: 1000,
      });
      for (const f of page.files) {
        if (f.deletedAt) continue;

        if (f.classification === "CACHE" || f.classification === "RENDER_PREVIEW") {
          addToAggregate(cache, f._id, f.sizeBytes);
        }
        if (f.projectId) {
          addToAggregate(byProject(filesByProject, f.projectId), f._id, f.sizeBytes);
          if (f.classification === "PROXY") {
            addToAggregate(byProject(proxiesByProject, f.projectId), f._id, f.sizeBytes);
          }
          if (f.classification === "EXPORT_FINAL") {
            if (f.source === "cloud") {
              cloudFinalCountByProject.set(f.projectId, (cloudFinalCountByProject.get(f.projectId) || 0) + 1);
            } else if (f.source === "local") {
              addToAggregate(byProject(localFinalsByProject, f.projectId), f._id, f.sizeBytes);
            }
          }
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    const allProjects: any[] = await ctx.runQuery(internal.recommendations.listProjectsForAnalysis, {
      tenantId: args.tenantId,
    });
    const openExactClusters: any[] = await ctx.runQuery(internal.recommendations.listOpenExactClusters, {
      tenantId: args.tenantId,
    });

    const recommendations = [];

    // --- RECOMMENDED ACTIONS GENERATION ---

    // A) Recommendation: Clean Cache & Renders (Safe Cleanup)
    if (cache.count > 0) {
      recommendations.push({
        type: "delete_cache",
        title: "Premiere & DaVinci cache",
        explanation: `Regenerable cache and peak files from video editing. These files can be safely deleted and will rebuild automatically when you reopen the active projects. This will immediately free up ${(cache.totalBytes / (1024 ** 4)).toFixed(2)} TB.`,
        affectedFileIds: cache.fileIds,
        affectedBytes: cache.totalBytes,
        riskLevel: "green",
        confidence: 1.0,
      });
    }

    // B) Recommendation: Clean Proxies for Delivered Projects (Safe Cleanup)
    const deliveredProjects = allProjects.filter((p) => p.status === "delivered" || p.status === "archived");
    const deliveredProxy = newAggregate();
    for (const project of deliveredProjects) {
      const agg = proxiesByProject.get(String(project._id));
      if (!agg) continue;
      for (const id of agg.fileIds) {
        if (deliveredProxy.fileIds.length < MAX_REC_FILE_IDS) deliveredProxy.fileIds.push(id);
      }
      deliveredProxy.totalBytes += agg.totalBytes;
      deliveredProxy.count += agg.count;
    }

    if (deliveredProxy.count > 0) {
      recommendations.push({
        type: "delete_proxies",
        title: "Proxies of delivered projects",
        explanation: `Generated proxy files for projects already completed and delivered. The camera RAW footage remains safely indexed and archived, so these temporary edit proxies are no longer needed. Clears ${(deliveredProxy.totalBytes / (1024 ** 3)).toFixed(1)} GB.`,
        affectedFileIds: deliveredProxy.fileIds,
        affectedBytes: deliveredProxy.totalBytes,
        riskLevel: "green",
        confidence: 0.95,
      });
    }

    // C) Recommendation: Remove Exact Duplicates (Safe/Review)
    if (openExactClusters.length > 0) {
      const totalWastedBytes = openExactClusters.reduce((acc, c) => acc + c.wastedBytes, 0);
      const duplicateFileIds: string[] = [];
      for (const cluster of openExactClusters) {
        const keepId = cluster.recommendedKeepFileId;
        for (const id of cluster.fileIds) {
          if (id !== keepId && duplicateFileIds.length < MAX_REC_FILE_IDS) duplicateFileIds.push(id);
        }
      }

      if (duplicateFileIds.length > 0) {
        recommendations.push({
          type: "remove_duplicate",
          title: "Remove exact duplicate media files",
          explanation: `Identical video clips and raw files copied multiple times across projects and drives. Deleting redundant copies and keeping the reference master will safely recover ${(totalWastedBytes / (1024 ** 4)).toFixed(2)} TB.`,
          affectedFileIds: duplicateFileIds,
          affectedBytes: totalWastedBytes,
          riskLevel: "green",
          confidence: 0.98,
        });
      }
    }

    // D) Recommendation: Move Delivered Projects from Hot to Warm Storage (Staging)
    const hotDeliveredProjects = deliveredProjects.filter((p) => p.tier === "hot" && p.status === "delivered");
    for (const project of hotDeliveredProjects) {
      const agg = filesByProject.get(String(project._id)) || newAggregate();
      recommendations.push({
        type: "move_to_warm",
        title: `Staging: Move completed "${project.name}" to Warm`,
        explanation: `Project "${project.name}" was marked as completed/delivered, but is currently sitting on your fast, active editing SSDs. Moving it to nearline storage preserves it while freeing up local workspace.`,
        projectId: String(project._id),
        affectedFileIds: agg.fileIds,
        affectedBytes: agg.totalBytes,
        riskLevel: "green",
        confidence: 0.9,
      });
    }

    // E) Recommendation: Archive Completed Projects to Cold Storage (Archive)
    const readyDeliveredProjects = deliveredProjects.filter((p) => p.status === "delivered" && p.storageHealthScore >= 80);
    for (const project of readyDeliveredProjects) {
      const agg = filesByProject.get(String(project._id)) || newAggregate();
      recommendations.push({
        type: "archive_project",
        title: `Archive: Cold archive "${project.name}"`,
        explanation: `Project "${project.name}" is fully delivered and has a storage health score of ${project.storageHealthScore}%. It is ready to be written to cold offline archive drives and marked complete.`,
        projectId: String(project._id),
        affectedFileIds: agg.fileIds,
        affectedBytes: agg.totalBytes,
        riskLevel: "yellow",
        confidence: 0.85,
      });
    }

    // F) Recommendation: Backup final exports to the cloud (Sync)
    const activeProjects = allProjects.filter((p) => p.status === "active" || p.status === "review");
    for (const project of activeProjects) {
      const localFinals = localFinalsByProject.get(String(project._id));
      const cloudFinals = cloudFinalCountByProject.get(String(project._id)) || 0;

      if (localFinals && localFinals.count > 0 && cloudFinals === 0) {
        recommendations.push({
          type: "copy_to_cloud",
          title: `Backup final exports of "${project.name}" to Cloud`,
          explanation: `Project "${project.name}" final exports do not exist on Google Drive. Uploading these masters ensures safe collaborative reviews and client handoffs.`,
          projectId: String(project._id),
          affectedFileIds: localFinals.fileIds,
          affectedBytes: localFinals.totalBytes,
          riskLevel: "yellow",
          confidence: 0.9,
        });
      }
    }

    await ctx.runMutation(internal.recommendations.replaceOpenRecommendations, {
      tenantId: args.tenantId,
      timestamp,
      recommendations,
    });

    return { success: true, count: recommendations.length };
  },
});

export const listProjectsForAnalysis = internalQuery({
  args: { tenantId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .collect();
  },
});

export const listOpenExactClusters = internalQuery({
  args: { tenantId: v.string() },
  handler: async (ctx, args) => {
    // Bounded: pull the top open clusters by wasted bytes via the indexed range
    // (never the whole table), then keep the exact ones. The recommendation only
    // needs the biggest wasters; a cap keeps this safe no matter the cluster count.
    const clusters = await ctx.db
      .query("duplicateClusters")
      .withIndex("by_tenant_status_wasted", (q) => q.eq("tenantId", args.tenantId).eq("status", "open"))
      .order("desc")
      .take(1000);
    return clusters.filter((c) => c.type === "exact");
  },
});

export const replaceOpenRecommendations = internalMutation({
  args: {
    tenantId: v.string(),
    timestamp: v.number(),
    recommendations: v.array(
      v.object({
        type: v.string(),
        title: v.string(),
        explanation: v.string(),
        projectId: v.optional(v.string()),
        affectedFileIds: v.array(v.string()),
        affectedBytes: v.number(),
        riskLevel: v.string(),
        confidence: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Clear this tenant's open recommendations to regenerate freshly.
    const openRecommendations = await ctx.db
      .query("recommendations")
      .withIndex("by_tenant_status", (q) => q.eq("tenantId", args.tenantId).eq("status", "open"))
      .collect();
    for (const rec of openRecommendations) {
      await ctx.db.delete(rec._id);
    }

    for (const rec of args.recommendations) {
      await ctx.db.insert("recommendations", {
        ...rec,
        tenantId: args.tenantId,
        status: "open",
        createdAt: args.timestamp,
        updatedAt: args.timestamp,
      });
    }
  },
});

export const updateStatus = mutation({
  args: {
    recommendationId: v.string(),
    status: v.string(), // "open" | "approved" | "ignored" | "completed" | "failed"
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const id = ctx.db.normalizeId("recommendations", args.recommendationId);
    if (!id) return;
    const rec = inTenant(await ctx.db.get(id), tenantId);
    if (!rec) return;
    await ctx.db.patch(id, {
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});
