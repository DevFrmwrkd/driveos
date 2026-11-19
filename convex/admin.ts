import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireRole, resolveMember } from "./access";
import { rateLimiter } from "./rateLimits";
import { consumeInvitation, hashInvitationToken, invitationMember, INVITATION_LIFETIME_MS, MEMBER_ROLES, newInvitationSecret, normalizedEmail } from "./invitations";

// Invitations are single-use bearer links. Administrators share them privately
// with the intended recipient; only a hash is stored in the database.
export const addTeamMember = mutation({
  args: { email: v.string(), name: v.string(), role: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, ["admin"]);
    await rateLimiter.limit(ctx, "addMember", { key: admin.email, throws: true });
    const email = normalizedEmail(args.email);
    const name = args.name.trim();
    if (!name || name.length > 200) throw new ConvexError("Enter a name of at most 200 characters.");
    if (!MEMBER_ROLES.includes(args.role as any)) throw new ConvexError("Choose a valid team role.");
    const users = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).collect();
    if (users.some((user) => user.tenantId && user.tenantId !== admin.tenantId)) {
      throw new ConvexError("This account already belongs to another workspace. DriveOS currently supports one workspace per account.");
    }
    const tenantMembers = await ctx.db.query("teamMembers")
      .withIndex("by_tenant", (q) => q.eq("tenantId", admin.tenantId)).collect();
    const existing = tenantMembers.find((member) => member.email === email);
    const accepted = existing && users.some((user) => user.teamMemberId === existing._id && user.tenantId === admin.tenantId);
    if (accepted) {
      if (existing._id === admin._id && args.role !== "admin") {
        throw new ConvexError("Ask another administrator to change your own role.");
      }
      await ctx.db.patch(existing._id, { name, role: args.role });
      return { updated: true, id: existing._id };
    }
    const secret = newInvitationSecret();
    const invitationTokenHash = await hashInvitationToken(secret);
    const invitationExpiresAt = Date.now() + INVITATION_LIFETIME_MS;
    const data = { name, role: args.role, invitationTokenHash, invitationExpiresAt };
    let id;
    if (existing) {
      id = existing._id;
      await ctx.db.patch(id, data);
    } else {
      id = await ctx.db.insert("teamMembers", { ...data, tenantId: admin.tenantId, email, createdAt: Date.now() });
    }
    return { created: !existing, updated: !!existing, id, invitationToken: `${id}.${secret}`, invitationExpiresAt };
  },
});

// Legacy accounts without an authoritative membership link may accept a fresh
// invitation after signing in. A linked account cannot be silently reassigned.
export const acceptInvitation = mutation({
  args: { invitationToken: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const id = identity && ctx.db.normalizeId("users", identity.subject.split("|")[0]);
    const user = id ? await ctx.db.get(id) : null;
    if (!user?.email) throw new ConvexError("Sign in before accepting this invitation.");
    const member = await invitationMember(ctx, args.invitationToken, normalizedEmail(user.email));
    const previousMemberId = user.teamMemberId && ctx.db.normalizeId("teamMembers", user.teamMemberId);
    const previousMember = previousMemberId ? await ctx.db.get(previousMemberId) : null;
    if ((user.tenantId && user.tenantId !== member.tenantId) ||
        (previousMember?.tenantId && previousMember._id !== member._id)) {
      throw new ConvexError("This account already belongs to a workspace. DriveOS currently supports one workspace per account.");
    }
    await ctx.db.patch(user._id, { teamMemberId: member._id, tenantId: member.tenantId });
    await consumeInvitation(ctx, member._id);
    return { accepted: true };
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
      .collect()
      .then((members) => members.map(({ invitationTokenHash, invitationExpiresAt, ...member }) => ({
        ...member,
        invitationPending: !!invitationTokenHash,
        invitationExpiresAt,
      })));
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
