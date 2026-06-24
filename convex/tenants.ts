import { v } from "convex/values";
import { mutation, query, internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { resolveMember, requireRole } from "./access";

// Who am I + which workspace am I in. Non-throwing: returns null when signed out.
export const currentContext = query({
  args: {},
  handler: async (ctx) => {
    const member = await resolveMember(ctx);
    if (!member) return null;
    const tenantId = ctx.db.normalizeId("tenants", member.tenantId);
    const tenant: any = tenantId ? await ctx.db.get(tenantId) : null;
    return {
      member: { id: member._id, name: member.name, email: member.email, role: member.role },
      tenant: tenant
        ? { id: tenant._id, name: tenant.name, slug: tenant.slug, plan: tenant.plan || "free" }
        : null,
    };
  },
});

// Rename the current workspace. Admins only, scoped to the caller's own tenant.
export const renameTenant = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const member = await requireRole(ctx, ["admin"]);
    const tenantId = ctx.db.normalizeId("tenants", member.tenantId);
    if (!tenantId) return { ok: false };
    const name = args.name.trim();
    if (!name) return { ok: false };
    await ctx.db.patch(tenantId, { name });
    return { ok: true };
  },
});

// ----------------------------------------------------------------------------
// One-time migration: stamp pre-multitenant rows onto a single default tenant
// so an existing deployment's data keeps showing after tenant scoping lands.
//
// INTERNAL ONLY. Run from the CLI (which has admin access):
//   npx convex run tenants:backfillExistingData --prod
// Never expose these publicly — a public version would let any anonymous client
// claim un-migrated rows into a tenant of their choosing.
// ----------------------------------------------------------------------------

const BACKFILL_TABLES = [
  "teamMembers",
  "machines",
  "drives",
  "scanSessions",
  "files",
  "projects",
  "folderTemplates",
  "duplicateClusters",
  "recommendations",
  "cleanupJobs",
  "quarantineItems",
  "cloudConnections",
  "cloudFiles",
  "archiveManifests",
  "auditLogs",
] as const;

export const ensureDefaultTenant = internalMutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_slug", (q) => q.eq("slug", "default"))
      .first();
    if (existing) return existing._id as unknown as string;
    const id = await ctx.db.insert("tenants", {
      name: "DriveOS",
      slug: "default",
      plan: "free",
      createdAt: Date.now(),
    });
    return id as unknown as string;
  },
});

// Patch up to `batch` rows of one table that have no tenantId yet.
export const backfillTablePage = internalMutation({
  args: { table: v.string(), tenantId: v.string(), batch: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query(args.table as any)
      .withIndex("by_tenant", (q: any) => q.eq("tenantId", undefined))
      .take(args.batch);
    for (const row of rows) {
      await ctx.db.patch(row._id, { tenantId: args.tenantId } as any);
    }
    return { patched: rows.length, done: rows.length < args.batch };
  },
});

// Driver: ensures the default tenant, then pages each table to stamp it.
export const backfillExistingData = internalAction({
  args: {},
  handler: async (ctx): Promise<{ tenantId: string; perTable: Record<string, number> }> => {
    const tenantId: string = await ctx.runMutation(internal.tenants.ensureDefaultTenant, {});
    const perTable: Record<string, number> = {};
    for (const table of BACKFILL_TABLES) {
      let total = 0;
      for (let i = 0; i < 400; i++) {
        const { patched, done } = await ctx.runMutation(internal.tenants.backfillTablePage, {
          table,
          tenantId,
          batch: 500,
        });
        total += patched;
        if (done) break;
      }
      perTable[table] = total;
    }
    return { tenantId, perTable };
  },
});
