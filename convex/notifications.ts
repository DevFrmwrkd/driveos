import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { deriveAlerts } from "@driveos/shared";

// ============================================================
// Notifications & Alerts Center
// ------------------------------------------------------------
// Persists the studio-wide alert feed. `refresh` recomputes the
// derived (source: "auto") alerts from the current storage state
// using the shared, deterministic alerts engine; manual alerts
// created via `create` are never auto-resolved.
// ============================================================

export const list = query({
  args: { limit: v.optional(v.number()), includeDismissed: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_createdAt")
      .order("desc")
      .take(args.limit ?? 100);
    const filtered = args.includeDismissed ? rows : rows.filter((r) => !r.dismissed);
    return filtered;
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_read", (q) => q.eq("read", false))
      .collect();
    return rows.filter((r) => !r.dismissed).length;
  },
});

export const markRead = mutation({
  args: { notificationId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("notifications", args.notificationId);
    if (!id) return { success: false };
    await ctx.db.patch(id, { read: true, updatedAt: Date.now() });
    return { success: true };
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_read", (q) => q.eq("read", false))
      .collect();
    const timestamp = Date.now();
    for (const row of rows) {
      if (!row.dismissed) await ctx.db.patch(row._id, { read: true, updatedAt: timestamp });
    }
    return { success: true, updated: rows.length };
  },
});

export const dismiss = mutation({
  args: { notificationId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("notifications", args.notificationId);
    if (!id) return { success: false };
    await ctx.db.patch(id, { dismissed: true, read: true, updatedAt: Date.now() });
    return { success: true };
  },
});

export const create = mutation({
  args: {
    severity: v.string(),
    category: v.string(),
    title: v.string(),
    message: v.string(),
    key: v.optional(v.string()),
    entityType: v.optional(v.string()),
    entityId: v.optional(v.string()),
    actionScreen: v.optional(v.string()),
    actionParams: v.optional(v.any()),
    metricBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const key = args.key || `manual-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    return await ctx.db.insert("notifications", {
      key,
      severity: args.severity,
      category: args.category,
      title: args.title,
      message: args.message,
      entityType: args.entityType,
      entityId: args.entityId,
      actionScreen: args.actionScreen,
      actionParams: args.actionParams,
      metricBytes: args.metricBytes,
      source: "manual",
      read: false,
      dismissed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    });
  },
});

/**
 * Recompute the derived alert feed from the live storage state.
 * Upserts by `key` so unread/read state is preserved across refreshes,
 * and auto-resolves derived alerts whose condition no longer holds.
 */
export const refresh = mutation({
  args: {},
  handler: async (ctx) => {
    const timestamp = Date.now();

    const [drives, projects, duplicateClusters, recommendations, machines] = await Promise.all([
      ctx.db.query("drives").collect(),
      ctx.db.query("projects").collect(),
      ctx.db.query("duplicateClusters").collect(),
      ctx.db.query("recommendations").collect(),
      ctx.db.query("machines").collect(),
    ]);

    const signals = deriveAlerts({
      drives,
      projects,
      duplicateClusters,
      recommendations,
      machines,
      now: timestamp,
    });
    const signalByKey = new Map(signals.map((s) => [s.key, s]));

    const existing = await ctx.db.query("notifications").collect();
    const existingAutoByKey = new Map(
      existing.filter((n) => n.source === "auto").map((n) => [n.key, n])
    );

    let created = 0;
    let updated = 0;
    let resolved = 0;

    // Upsert active signals.
    for (const signal of signals) {
      const prior = existingAutoByKey.get(signal.key);
      if (prior) {
        await ctx.db.patch(prior._id, {
          severity: signal.severity,
          category: signal.category,
          title: signal.title,
          message: signal.message,
          entityType: signal.entityType,
          entityId: signal.entityId,
          actionScreen: signal.actionScreen,
          actionParams: signal.actionParams,
          metricBytes: signal.metricBytes,
          // A re-surfaced alert that was dismissed becomes active again.
          dismissed: false,
          updatedAt: timestamp,
          lastSeenAt: timestamp,
        });
        updated++;
      } else {
        await ctx.db.insert("notifications", {
          key: signal.key,
          severity: signal.severity,
          category: signal.category,
          title: signal.title,
          message: signal.message,
          entityType: signal.entityType,
          entityId: signal.entityId,
          actionScreen: signal.actionScreen,
          actionParams: signal.actionParams,
          metricBytes: signal.metricBytes,
          source: "auto",
          read: false,
          dismissed: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastSeenAt: timestamp,
        });
        created++;
      }
    }

    // Auto-resolve derived alerts whose condition cleared.
    for (const [key, row] of existingAutoByKey) {
      if (!signalByKey.has(key) && !row.dismissed) {
        await ctx.db.patch(row._id, { dismissed: true, read: true, updatedAt: timestamp });
        resolved++;
      }
    }

    return { success: true, total: signals.length, created, updated, resolved };
  },
});
