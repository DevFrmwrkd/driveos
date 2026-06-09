import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireRole, resolveIdentityEmail } from "./access";
import { rateLimiter } from "./rateLimits";

// Bootstrap helper: create the first admin team member if none exists yet.
// Safe and idempotent — only inserts when the email is not already present, and
// refuses to run once any admin already exists (so it can't be used to grant
// access later). Used once to seed the founding admin before auth is enabled.
export const bootstrapFirstAdmin = mutation({
  args: { email: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();

    const existingAdmin = await ctx.db
      .query("teamMembers")
      .filter((q) => q.eq(q.field("role"), "admin"))
      .first();
    if (existingAdmin) {
      return { created: false, reason: "An admin already exists.", adminEmail: existingAdmin.email };
    }

    const existingByEmail = await ctx.db
      .query("teamMembers")
      .filter((q) => q.eq(q.field("email"), email))
      .first();
    if (existingByEmail) {
      await ctx.db.patch(existingByEmail._id, { role: "admin" });
      return { created: false, promoted: true, id: existingByEmail._id };
    }

    const id = await ctx.db.insert("teamMembers", {
      name: args.name,
      email,
      role: "admin",
      createdAt: Date.now(),
    });
    return { created: true, id };
  },
});

// Admin-only: add a team member (the invite mechanism — sign-up is allowlisted to
// existing team members, so this is how new people gain dashboard access).
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
    const existing = await ctx.db
      .query("teamMembers")
      .filter((q) => q.eq(q.field("email"), email))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { name: args.name, role: args.role });
      return { updated: true, id: existing._id };
    }
    const id = await ctx.db.insert("teamMembers", {
      name: args.name,
      email,
      role: args.role,
      createdAt: Date.now(),
    });
    return { created: true, id };
  },
});

// List team members (for the Settings → Team UI). Requires a signed-in member.
export const listTeamMembers = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db.query("teamMembers").collect();
  },
});

// Who am I — resolves the signed-in user to their team member record (or null).
export const me = query({
  args: {},
  handler: async (ctx) => {
    const email = await resolveIdentityEmail(ctx);
    if (!email) return null;
    const member = await ctx.db
      .query("teamMembers")
      .filter((q) => q.eq(q.field("email"), email))
      .first();
    return member ? { name: member.name, email: member.email, role: member.role } : null;
  },
});
