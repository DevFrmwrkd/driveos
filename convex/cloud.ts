import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember, inTenant } from "./access";

export const listConnections = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("cloudConnections")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
  },
});

export const listFiles = query({
  args: { projectId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    if (args.projectId) {
      return await ctx.db
        .query("cloudFiles")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
        .filter((q) => q.eq(q.field("projectId"), args.projectId))
        .collect();
    }
    return await ctx.db
      .query("cloudFiles")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
  },
});

export const addConnection = mutation({
  args: {
    accountEmail: v.string(),
    quotaBytesTotal: v.number(),
    quotaBytesUsed: v.number(),
    status: v.string(), // "connected" | "disconnected" | "demo"
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const timestamp = Date.now();
    const existing = await ctx.db
      .query("cloudConnections")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .filter((q) => q.eq(q.field("accountEmail"), args.accountEmail))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        quotaBytesTotal: args.quotaBytesTotal,
        quotaBytesUsed: args.quotaBytesUsed,
        status: args.status,
        lastSyncAt: timestamp,
      });
      return existing._id;
    } else {
      const connId = await ctx.db.insert("cloudConnections", {
        tenantId,
        provider: "google_drive",
        accountEmail: args.accountEmail,
        status: args.status,
        quotaBytesTotal: args.quotaBytesTotal,
        quotaBytesUsed: args.quotaBytesUsed,
        lastSyncAt: timestamp,
        createdAt: timestamp,
      });

      await ctx.db.insert("auditLogs", {
        tenantId,
        action: "cloud_connect",
        entityType: "cloudConnection",
        entityId: connId,
        message: `Connected Google Drive account ${args.accountEmail}`,
        createdAt: timestamp,
      });

      return connId;
    }
  },
});

export const uploadCloudFileBatch = mutation({
  args: {
    connectionId: v.string(),
    files: v.array(
      v.object({
        providerFileId: v.string(),
        name: v.string(),
        path: v.string(),
        parentId: v.string(),
        sizeBytes: v.number(),
        mimeType: v.string(),
        md5Checksum: v.optional(v.string()),
        modifiedTime: v.number(),
        classification: v.string(),
        projectId: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const connectionIdObj = ctx.db.normalizeId("cloudConnections", args.connectionId);
    if (!connectionIdObj) return { success: false };
    const connection = inTenant(await ctx.db.get(connectionIdObj), tenantId);
    if (!connection) return { success: false };

    const timestamp = Date.now();

    for (const f of args.files) {
      const existing = await ctx.db
        .query("cloudFiles")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
        .filter((q) => q.eq(q.field("providerFileId"), f.providerFileId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          name: f.name,
          path: f.path,
          parentId: f.parentId,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          md5Checksum: f.md5Checksum,
          modifiedTime: f.modifiedTime,
          classification: f.classification,
          projectId: f.projectId,
        });
      } else {
        await ctx.db.insert("cloudFiles", {
          tenantId,
          provider: "google_drive",
          providerFileId: f.providerFileId,
          cloudConnectionId: args.connectionId,
          name: f.name,
          path: f.path,
          parentId: f.parentId,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          md5Checksum: f.md5Checksum,
          modifiedTime: f.modifiedTime,
          trashed: false,
          projectId: f.projectId,
          classification: f.classification,
        });
      }
    }

    await ctx.db.patch(connectionIdObj, {
      lastSyncAt: timestamp,
    });

    await ctx.db.insert("auditLogs", {
      tenantId,
      action: "cloud_sync",
      entityType: "cloudConnection",
      entityId: args.connectionId,
      message: `Synced ${args.files.length} metadata records from Google Drive`,
      createdAt: timestamp,
    });

    return { success: true };
  },
});
