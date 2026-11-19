import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ResendOTPPasswordReset } from "./ResendOTP";
import { consumeInvitation, invitationMember, normalizedEmail } from "./invitations";
import { backfillLinkedUserTenant } from "./access";

// Open signup creates an isolated workspace. Joining an existing workspace
// requires an administrator's single-use invitation; email alone never grants
// membership. Existing linked accounts keep their current workspace.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      // Map sign-in/up params -> stored profile. Signup passes name + orgName.
      profile(params) {
        return {
          email: normalizedEmail(String(params.email ?? "")),
          name: (params as any).name ? String((params as any).name) : undefined,
          orgName: params.orgName ? String(params.orgName) : undefined,
          invitationToken: params.flow === "signUp" && params.invitationToken ? String(params.invitationToken) : undefined,
        } as any;
      },
      reset: ResendOTPPasswordReset,
    }),
  ],
  callbacks: {
    async createOrUpdateUser(ctx: MutationCtx, args) {
      const email = normalizedEmail(String(args.profile.email ?? ""));

      if (args.existingUserId) {
        const existingUser = await ctx.db.get(args.existingUserId);
        await backfillLinkedUserTenant(ctx, existingUser);
        // Reset-code verification may update the existing account, but must
        // never backfill workspace membership from a user-supplied address.
        if (args.type === "verification" && args.profile.emailVerified === true) {
          await ctx.db.patch(args.existingUserId, { emailVerificationTime: Date.now() });
        }
        return args.existingUserId;
      }

      const now = Date.now();
      const personName =
        (args.profile as any).name?.toString().trim() || email.split("@")[0];

      const invitationToken = String((args.profile as any).invitationToken ?? "");
      if (invitationToken) {
        const member = await invitationMember(ctx, invitationToken, email);
        const userId = await ctx.db.insert("users", {
          email,
          name: member.name || personName,
          teamMemberId: member._id,
          tenantId: member.tenantId,
        });
        await consumeInvitation(ctx, member._id);
        return userId;
      }
      const existingMember = await ctx.db.query("teamMembers")
        .withIndex("by_email", (q) => q.eq("email", email)).first();
      if (existingMember) {
        throw new ConvexError("Use the invitation link from your workspace administrator to join this workspace.");
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
