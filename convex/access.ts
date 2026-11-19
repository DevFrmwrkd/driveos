import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";

export interface Member {
  _id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string;
}

// The stored member id is the authority for legacy accounts too. Early auth
// users already had this link before tenantId was copied onto the users table.
// Accept a missing copy, but never an explicit conflicting tenant or email.
async function linkedMember(ctx: QueryCtx | MutationCtx, user: any) {
  if (!user?.teamMemberId) return null;
  const memberId = ctx.db.normalizeId("teamMembers", user.teamMemberId);
  const member = memberId ? await ctx.db.get(memberId) : null;
  if (!member?.tenantId ||
      (user.tenantId !== undefined && member.tenantId !== user.tenantId) ||
      member.email !== String(user.email ?? "").trim().toLowerCase()) return null;
  return { ...member, tenantId: member.tenantId };
}

// Optional persistence repair for trusted auth callbacks and internal migration.
// This never looks up a membership from a supplied email or changes an existing
// tenant assignment; ordinary reads work while legacy rows await backfill.
export async function backfillLinkedUserTenant(ctx: MutationCtx, user: any): Promise<boolean> {
  if (!user || user.tenantId !== undefined) return false;
  const member = await linkedMember(ctx, user);
  if (!member) return false;
  await ctx.db.patch(user._id, { tenantId: member.tenantId });
  return true;
}

// Resolve the signed-in dashboard user to their team member record (scoped to
// their tenant), or throw. Use in every query/mutation that should require an
// authorized team member. The returned `tenantId` MUST be used to scope all
// reads/writes so one organization can never see another's data.
//
// Convex Auth's Password provider does NOT put `email` in the JWT identity — the
// identity's `subject` is the auth user's _id. We resolve the user row first
// (the authoritative link to teamMember + tenant). Email is not authorization.
export async function requireMember(ctx: QueryCtx | MutationCtx): Promise<Member> {
  const member = await resolveMember(ctx);
  if (!member) {
    throw new ConvexError(
      "Your account is not linked to a DriveOS workspace. Ask an administrator for an invitation link."
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
    const member = await linkedMember(ctx, user);
    if (member) {
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
