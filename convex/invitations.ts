import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const MEMBER_ROLES = ["admin", "producer", "editor", "assistant_editor", "viewer"] as const;

export function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new ConvexError("Enter a valid email address.");
  }
  return email;
}

export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newInvitationSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// An invitation is bearer authorization from an administrator, not proof that
// an email address has been verified. Never resolve workspace access by email.
export async function invitationMember(ctx: MutationCtx, token: string, email: string) {
  const [rawId, secret, extra] = token.split(".");
  const id = ctx.db.normalizeId("teamMembers", rawId || "");
  const member = id ? await ctx.db.get(id) : null;
  if (extra !== undefined || !/^[a-f0-9]{64}$/.test(secret || "") ||
      !member?.tenantId || member.email !== email ||
      !member.invitationTokenHash || !member.invitationExpiresAt ||
      member.invitationExpiresAt <= Date.now() ||
      member.invitationTokenHash !== await hashInvitationToken(secret)) {
    throw new ConvexError("This invitation is invalid or expired. Ask your workspace administrator for a new link.");
  }
  return member;
}

export async function consumeInvitation(ctx: MutationCtx, memberId: any) {
  await ctx.db.patch(memberId, {
    invitationTokenHash: undefined,
    invitationExpiresAt: undefined,
  });
}
