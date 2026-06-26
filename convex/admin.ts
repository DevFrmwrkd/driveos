import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember, requireRole, resolveMember } from "./access";
import { rateLimiter } from "./rateLimits";

// Admin-only: invite a team member into the admin's OWN workspace (tenant).
// When that email later signs up, auth.ts links them into this same tenant.
export const addTeamMember = mutation({
  args: {
    email: v.string(),
    name: v.string(),
    role: v.string(), // "admin" | "producer" | "editor" | "assistant_editor" | "viewer"
  },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, ["admin"]);
    await rateLimiter.limit(ctx, "addMember", { key: admin.email, throws: true });
    const email = args.email.trim().toLowerCase();

    // Only consider members already in THIS tenant when deciding insert vs update.
    const tenantMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_tenant", (q) => q.eq("tenantId", admin.tenantId))
      .collect();
    const existing = tenantMembers.find((m) => m.email === email);

    if (existing) {
      await ctx.db.patch(existing._id, { name: args.name, role: args.role });
      return { updated: true, id: existing._id };
    }
    const id = await ctx.db.insert("teamMembers", {
      tenantId: admin.tenantId,
      name: args.name,
      email,
      role: args.role,
      createdAt: Date.now(),
    });
    return { created: true, id };
  },
});

// List team members in the caller's workspace (for Settings → Team).
export const listTeamMembers = query({
  args: {},
  handler: async (ctx) => {
    const member = await resolveMember(ctx);
    if (!member) return [];
    return await ctx.db
      .query("teamMembers")
      .withIndex("by_tenant", (q) => q.eq("tenantId", member.tenantId))
      .collect();
  },
});

// Who am I — resolves the signed-in user to their team member record (or null).
export const me = query({
  args: {},
  handler: async (ctx) => {
    const member = await resolveMember(ctx);
    return member
      ? { name: member.name, email: member.email, role: member.role, tenantId: member.tenantId }
      : null;
  },
});
