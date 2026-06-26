import { v, ConvexError } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import { requireMember } from "./access";
import { rateLimiter } from "./rateLimits";

// Per-machine agent tokens, scoped to the issuing member's tenant.
//
// Flow:
//  1. A signed-in team member calls `issueMachineToken` from the dashboard for a
//     machine. We generate a random token, store ONLY its SHA-256 hash on the
//     machine row (stamped with the member's tenantId), and return plaintext once.
//  2. The editor runs `driveos-agent connect --token <token>`; the agent saves it.
//  3. Every agent HTTP call sends `Authorization: Bearer <token>`. The HTTP layer
//     hashes it and calls `verifyMachineToken` — the returned tenantId is then
//     used to stamp every row the agent writes, isolating it to that workspace.

// SHA-256 hex. Available in the Convex runtime via Web Crypto (globalThis.crypto).
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Generate a URL-safe random token (32 bytes).
function generateToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Dashboard-only: mint (or rotate) a token for a machine. Requires a team member.
export const issueMachineToken = mutation({
  args: {
    machineName: v.string(),
    ownerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const member = await requireMember(ctx);
    await rateLimiter.limit(ctx, "issueToken", { key: member.email, throws: true });

    const token = generateToken();
    const tokenHash = await hashToken(token);
    const timestamp = Date.now();

    // Match an existing machine of the same name WITHIN this tenant only.
    const tenantMachines = await ctx.db
      .query("machines")
      .withIndex("by_tenant", (q) => q.eq("tenantId", member.tenantId))
      .collect();
    const existing = tenantMachines.find((m) => m.name === args.machineName);

    let machineId;
    if (existing) {
      await ctx.db.patch(existing._id, { authTokenHash: tokenHash, lastSeenAt: timestamp });
      machineId = existing._id;
    } else {
      machineId = await ctx.db.insert("machines", {
        tenantId: member.tenantId,
        name: args.machineName,
        ownerId: args.ownerId || member.email || "local-system",
        agentVersion: "pending",
        platform: "pending",
        lastSeenAt: timestamp,
        status: "offline",
        authTokenHash: tokenHash,
        createdAt: timestamp,
      });
    }

    await ctx.db.insert("auditLogs", {
      tenantId: member.tenantId,
      actorId: member.email,
      machineId,
      action: "machine_token_issued",
      entityType: "machine",
      entityId: machineId,
      message: `Issued an agent token for machine "${args.machineName}".`,
      createdAt: timestamp,
    });

    // Returned once; only the hash is persisted.
    return { token, machineId, machineName: args.machineName };
  },
});

// Used by the HTTP layer (internal-only): returns the machine + its tenantId if
// the hash matches. Internal so it can't be used as a public token/tenant oracle.
export const verifyMachineToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    if (!args.tokenHash) return null;
    const machine = await ctx.db
      .query("machines")
      .withIndex("by_tokenHash", (q) => q.eq("authTokenHash", args.tokenHash))
      .first();
    return machine
      ? { machineId: machine._id, name: machine.name, tenantId: machine.tenantId || "" }
      : null;
  },
});

// Dashboard-only: revoke a machine's token (only within the caller's tenant).
export const revokeMachineToken = mutation({
  args: { machineId: v.string() },
  handler: async (ctx, args) => {
    const member = await requireMember(ctx);
    const id = ctx.db.normalizeId("machines", args.machineId);
    if (!id) throw new ConvexError("Unknown machine.");
    const machine = await ctx.db.get(id);
    if (!machine || machine.tenantId !== member.tenantId) {
      throw new ConvexError("Unknown machine.");
    }
    await ctx.db.patch(id, { authTokenHash: undefined, status: "offline" });
    return { success: true };
  },
});
