// TEMPORARY: one-time admin ops without dashboard login. Remove after use.
import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const removeDriveByLabel = mutation({
  args: { label: v.string() },
  handler: async (ctx, args) => {
    const drive = await ctx.db.query("drives").filter((q) => q.eq(q.field("label"), args.label)).first();
    if (!drive) return { removed: false, reason: "not found" };
    const files = await ctx.db.query("files").withIndex("by_drive", (q) => q.eq("driveId", drive._id)).collect();
    for (const f of files) await ctx.db.delete(f._id);
    await ctx.db.delete(drive._id);
    return { removed: true, label: args.label, filesRemoved: files.length };
  },
});

export const addMember = mutation({
  args: { name: v.string(), email: v.string(), role: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const existing = await ctx.db.query("teamMembers").filter((q) => q.eq(q.field("email"), email)).first();
    if (existing) { await ctx.db.patch(existing._id, { name: args.name, role: args.role }); return { updated: true }; }
    await ctx.db.insert("teamMembers", { name: args.name, email, role: args.role, createdAt: Date.now() });
    return { created: true };
  },
});
