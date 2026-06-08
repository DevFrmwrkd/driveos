import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";

// Email+password auth. No email server / custom domain needed (verification is
// intentionally off for this internal tool). Sign-up is NOT open: an account can
// only be created for an email that already exists in `teamMembers`, so the
// dashboard is invite/admin-created only.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
  callbacks: {
    async createOrUpdateUser(ctx: MutationCtx, args) {
      const email = (args.profile.email ?? "").toString().trim().toLowerCase();
      if (!email) {
        throw new ConvexError("An email is required to sign in.");
      }

      // Allowlist gate: the email must belong to a known team member.
      const member = await ctx.db
        .query("teamMembers")
        .filter((q) => q.eq(q.field("email"), email))
        .first();
      if (!member) {
        throw new ConvexError(
          "This email is not authorized. Ask a DriveOS admin to add you to the team first."
        );
      }

      if (args.existingUserId) {
        return args.existingUserId;
      }

      // Link the new auth user back to the team member for role lookups.
      return ctx.db.insert("users", {
        email,
        name: member.name,
        teamMemberId: member._id,
      } as any);
    },
  },
});
