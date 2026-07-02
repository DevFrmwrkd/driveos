import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// Application-layer rate limits (defense-in-depth + keeps Convex from being
// hammered). Login brute-force is already handled by Convex Auth's built-in
// per-account failed-attempt limit (~10/hour), so it's intentionally not here.
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Authenticated agent traffic, keyed per machine. An hourly sync fires a short
  // burst (~6 calls) then idles, so a token bucket with headroom never blocks
  // normal use but caps a runaway or misbehaving agent.
  agentApi: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 240 },

  // Unauthenticated agent calls (missing/invalid token), keyed per IP. Tighter,
  // to slow token-guessing against the /api/* routes.
  agentApiAnon: { kind: "token bucket", rate: 20, period: MINUTE, capacity: 20 },

  // Hard daily budget on file-metadata upserts, keyed per tenant and consumed
  // per FILE (not per call). This is the backstop that makes a runaway agent
  // (or a bug reintroducing full-catalog re-uploads) physically unable to burn
  // database bandwidth. The 250k burst permits a large initial catalog; after
  // that the whole workspace can submit at most 100k changed records/day.
  // At the observed document sizes this caps this path well below 1% of the
  // incident's ~41 GB/day while healthy delta sync uses a tiny fraction.
  agentFileSync: { kind: "token bucket", rate: 100_000, period: 24 * HOUR, capacity: 250_000 },

  // Dashboard: issuing/rotating machine tokens, keyed per team member.
  issueToken: { kind: "token bucket", rate: 20, period: HOUR, capacity: 10 },

  // Dashboard: adding team members, keyed per team member.
  addMember: { kind: "token bucket", rate: 30, period: HOUR, capacity: 10 },
});

// Called from the HTTP layer (httpActions can't use the rate limiter directly —
// it needs db access). Internal-only. Returns { ok, retryAfter } so http.ts can
// answer 429.
export const checkAgentRateLimit = internalMutation({
  args: {
    authenticated: v.boolean(),
    key: v.string(), // machine id when authenticated, else client IP
  },
  handler: async (ctx, args) => {
    const name = args.authenticated ? "agentApi" : "agentApiAnon";
    return await rateLimiter.limit(ctx, name, { key: args.key });
  },
});

// Per-tenant daily file-upsert budget, consumed per file in the batch. Called
// from the uploadBatch HTTP route; a failure means the workspace exhausted its
// quota and every agent should stop sending catalog rows until refill.
export const checkUploadBudget = internalMutation({
  args: {
    tenantId: v.string(),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    return await rateLimiter.limit(ctx, "agentFileSync", {
      key: args.tenantId,
      count: Math.max(1, args.count),
    });
  },
});
