import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./access";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("auditLogs")
      .withIndex("by_tenant_createdAt", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(100);
  },
});

export const add = mutation({
  args: {
    actorId: v.optional(v.string()),
    machineId: v.optional(v.string()),
    action: v.string(),
    entityType: v.string(),
    entityId: v.optional(v.string()),
    message: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const timestamp = Date.now();
    const logId = await ctx.db.insert("auditLogs", {
      tenantId,
      actorId: args.actorId,
      machineId: args.machineId,
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      message: args.message,
      metadata: args.metadata || {},
      createdAt: timestamp,
    });
    return logId;
  },
});
