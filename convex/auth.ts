import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ResendOTPPasswordReset } from "./ResendOTP";

// Email + password auth, multi-tenant and open signup.
//
//  - A brand-new email creates its own tenant (organization) plus an admin
//    teamMember, and links the auth user to both.
//  - An email that already belongs to a teamMember (e.g. invited into an
//    existing workspace) signs into THAT workspace instead of creating a new one.
//  - Password reset codes are delivered via Resend (see ResendOTP.ts). Email
//    verification is intentionally NOT a hard gate so signup is never blocked by
//    email deliverability; a best-effort welcome email is sent instead.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      // Map sign-in/up params -> stored profile. Signup passes name + orgName.
      profile(params) {
        return {
          email: String((params as any).email ?? "").trim().toLowerCase(),
          name: (params as any).name ? String((params as any).name) : undefined,
          orgName: (params as any).orgName ? String((params as any).orgName) : undefined,
        } as any;
      },
      reset: ResendOTPPasswordReset,
    }),
  ],
  callbacks: {
    async createOrUpdateUser(ctx: MutationCtx, args) {
      const email = (args.profile.email ?? "").toString().trim().toLowerCase();
      if (!email) {
        throw new ConvexError("An email is required to sign in.");
      }

      // Returning user signing in again — keep their existing user row.
      if (args.existingUserId) {
        await ensureUserLinked(ctx, args.existingUserId, email, args.profile);
        return args.existingUserId;
      }

      const now = Date.now();
      const personName =
        (args.profile as any).name?.toString().trim() || email.split("@")[0];

      // Email already known as a team member -> join that existing workspace.
      const existingMember: any = await ctx.db
        .query("teamMembers")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (existingMember && existingMember.tenantId) {
        return ctx.db.insert("users", {
          email,
          name: existingMember.name || personName,
          teamMemberId: existingMember._id,
          tenantId: existingMember.tenantId,
        } as any);
      }

      // Brand-new account -> create a fresh tenant + admin member.
      const orgName =
        (args.profile as any).orgName?.toString().trim() || defaultOrgName(email);
      const tenantId = await ctx.db.insert("tenants", {
        name: orgName,
        slug: await uniqueSlug(ctx, orgName),
        plan: "free",
        createdAt: now,
      });

      const memberId = await ctx.db.insert("teamMembers", {
        tenantId,
        name: personName,
        email,
        role: "admin",
        createdAt: now,
      });

      const userId = await ctx.db.insert("users", {
        email,
        name: personName,
        teamMemberId: memberId,
        tenantId,
      } as any);

      await ctx.db.patch(tenantId, { ownerUserId: userId });

      // Best-effort welcome email (scheduled so it never blocks signup).
      await ctx.scheduler.runAfter(0, internal.emails.sendWelcome, {
        email,
        name: personName,
        orgName,
      });

      return userId;
    },
  },
});

// Backfill the user<->member<->tenant link for older accounts created before
// the multi-tenant migration, so they resolve correctly on next sign-in.
async function ensureUserLinked(
  ctx: MutationCtx,
  userId: any,
  email: string,
  profile: any
) {
  const user: any = await ctx.db.get(userId);
  if (!user) return;
  if (user.tenantId && user.teamMemberId) return;

  const member: any = await ctx.db
    .query("teamMembers")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (member && member.tenantId) {
    await ctx.db.patch(userId, {
      teamMemberId: member._id,
      tenantId: member.tenantId,
      name: user.name || member.name || profile?.name,
    });
  }
}

function defaultOrgName(email: string): string {
  const domain = email.split("@")[1] || "";
  const base = domain.split(".")[0] || email.split("@")[0] || "workspace";
  return base.charAt(0).toUpperCase() + base.slice(1) + " Studio";
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

async function uniqueSlug(ctx: MutationCtx, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${Math.floor(Math.random() * 9000) + 1000}`;
    const clash = await ctx.db
      .query("tenants")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .first();
    if (!clash) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
