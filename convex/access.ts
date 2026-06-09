import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";

export interface Member {
  _id: string;
  name: string;
  email: string;
  role: string;
}

// Resolve the signed-in dashboard user to their team member record, or throw.
// Use in every query/mutation that should require an authorized team member.
//
// Convex Auth's Password provider does NOT put `email` in the JWT identity — the
// identity's `subject` is the auth user's _id. So we resolve the email from the
// `users` table first (via subject), and fall back to identity.email if present.
export async function requireMember(ctx: QueryCtx | MutationCtx): Promise<Member> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError("Not signed in.");
  }

  const email = await resolveIdentityEmail(ctx);

  if (email) {
    const member = await ctx.db
      .query("teamMembers")
      .filter((q) => q.eq(q.field("email"), email))
      .first();
    if (member) {
      return { _id: member._id, name: member.name, email: member.email, role: member.role };
    }
  }

  throw new ConvexError("Your account is not linked to a DriveOS team member.");
}

// Resolve the signed-in user's email (from identity, or via the users table by
// subject when the provider doesn't set the email claim). Returns "" if absent.
export async function resolveIdentityEmail(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return "";
  let email = (identity.email ?? "").toString().trim().toLowerCase();
  if (!email) {
    // Convex Auth's subject is the user _id, sometimes as "<userId>|<sessionId>".
    const subjectId = String(identity.subject || "").split("|")[0];
    const userId = ctx.db.normalizeId("users", subjectId);
    if (userId) {
      const user = await ctx.db.get(userId);
      const userEmail = (user as any)?.email;
      if (userEmail) email = String(userEmail).trim().toLowerCase();
    }
  }
  return email;
}

// Require one of the given roles (e.g. block "viewer" from destructive actions).
export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  roles: string[]
): Promise<Member> {
  const member = await requireMember(ctx);
  if (!roles.includes(member.role)) {
    throw new ConvexError(`This action requires one of: ${roles.join(", ")}.`);
  }
  return member;
}
