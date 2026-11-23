import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireMember, requireRole } from "./access";
import { invalidateAnalysisInputs } from "./catalogAnalysis";

export const cleanupRulesValidator = v.object({
  rawKeep: v.boolean(), proxyDelete: v.boolean(), cacheDelete: v.boolean(),
  finalKeep: v.boolean(), licenseKeep: v.boolean(),
});

export const DEFAULT_CLEANUP_RULES = {
  rawKeep: true, proxyDelete: true, cacheDelete: true, finalKeep: true, licenseKeep: true,
};

export async function workspaceSettings(ctx: any, tenantId: string) {
  const row = await ctx.db.query("workspaceSettings")
    .withIndex("by_tenant", (q: any) => q.eq("tenantId", tenantId)).first();
  return {
    retentionDays: row?.retentionDays ?? 14,
    cleanupRules: row?.cleanupRules ?? DEFAULT_CLEANUP_RULES,
  };
}

export function validateCleanupRules(rules: typeof DEFAULT_CLEANUP_RULES) {
  if (!rules.rawKeep || !rules.finalKeep || !rules.licenseKeep) {
    throw new ConvexError("RAW, final exports, and license/admin files must remain protected.");
  }
}

export const get = query({
  args: {},
  handler: async (ctx) => workspaceSettings(ctx, (await requireMember(ctx)).tenantId),
});

export const forAnalysis = internalQuery({
  args: { tenantId: v.string() },
  handler: (ctx, args) => workspaceSettings(ctx, args.tenantId),
});

export const update = mutation({
  args: { retentionDays: v.optional(v.number()), cleanupRules: v.optional(cleanupRulesValidator) },
  handler: async (ctx, args) => {
    const member = await requireRole(ctx, ["admin"]);
    if (args.retentionDays !== undefined &&
      (!Number.isInteger(args.retentionDays) || args.retentionDays < 1 || args.retentionDays > 90)) {
      throw new ConvexError("Retention must be a whole number from 1 to 90 days.");
    }
    if (args.cleanupRules) validateCleanupRules(args.cleanupRules);
    const existing = await ctx.db.query("workspaceSettings")
      .withIndex("by_tenant", q => q.eq("tenantId", member.tenantId)).first();
    const current = await workspaceSettings(ctx, member.tenantId);
    const next = { ...current, ...args, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, next);
    else await ctx.db.insert("workspaceSettings", { tenantId: member.tenantId, ...next });
    if (current.cleanupRules.cacheDelete !== next.cleanupRules.cacheDelete ||
        current.cleanupRules.proxyDelete !== next.cleanupRules.proxyDelete) await invalidateAnalysisInputs(ctx, member.tenantId);
    return next;
  },
});
