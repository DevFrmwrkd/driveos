import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";

export interface Member {
  _id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string;
}

// Resolve the signed-in dashboard user to their team member record (scoped to
// their tenant), or throw. Use in every query/mutation that should require an
// authorized team member. The returned `tenantId` MUST be used to scope all
// reads/writes so one organization can never see another's data.
//
// Convex Auth's Password provider does NOT put `email` in the JWT identity — the
// identity's `subject` is the auth user's _id. We resolve the user row first
// (the authoritative link to teamMember + tenant), and fall back to email.
export async function requireMember(ctx: QueryCtx | MutationCtx): Promise<Member> {
  const member = await resolveMember(ctx);
  if (!member) {
    throw new ConvexError(
      "Your account is not linked to a DriveOS workspace. Sign out and sign up again."
    );
  }
  return member;
}

// Non-throwing variant for "who am I"-style queries.
export async function resolveMember(
  ctx: QueryCtx | MutationCtx
): Promise<Member | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  // 1) Authoritative path: subject -> users row -> teamMember (carries tenantId).
  const subjectId = String(identity.subject || "").split("|")[0];
  const userId = ctx.db.normalizeId("users", subjectId);
  if (userId) {
    const user: any = await ctx.db.get(userId);
    if (user?.teamMemberId) {
      const memberId = ctx.db.normalizeId("teamMembers", user.teamMemberId);
      const member: any = memberId ? await ctx.db.get(memberId) : null;
      if (member && member.tenantId) {
        return {
          _id: member._id,
          name: member.name,
          email: member.email,
          role: member.role,
          tenantId: member.tenantId,
        };
      }
    }
  }

  // 2) Fallback: resolve by email (older accounts not yet linked via users row).
  const email = await resolveIdentityEmail(ctx);
  if (email) {
    const member: any = await ctx.db
      .query("teamMembers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (member && member.tenantId) {
      return {
        _id: member._id,
        name: member.name,
        email: member.email,
        role: member.role,
        tenantId: member.tenantId,
      };
    }
  }

  return null;
}

// Convenience: the caller's tenant id (throws if unauthenticated / unlinked).
export async function requireTenantId(
  ctx: QueryCtx | MutationCtx
): Promise<string> {
  return (await requireMember(ctx)).tenantId;
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

// Ownership guard for get-by-id reads/writes: a row only belongs to the caller
// when its tenantId matches. Returns the row when it matches, else null — never
// leak existence of another tenant's row.
export function inTenant<T extends { tenantId?: string }>(
  doc: T | null,
  tenantId: string
): T | null {
  if (!doc) return null;
  if ((doc as any).tenantId !== tenantId) return null;
  return doc;
}
