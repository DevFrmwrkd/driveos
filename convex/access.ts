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
export async function requireMember(ctx: QueryCtx | MutationCtx): Promise<Member> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError("Not signed in.");
  }

  const email = (identity.email ?? "").toString().trim().toLowerCase();
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
