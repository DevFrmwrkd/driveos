import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

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

  // Dashboard: issuing/rotating machine tokens, keyed per team member.
  issueToken: { kind: "token bucket", rate: 20, period: HOUR, capacity: 10 },

  // Dashboard: adding team members, keyed per team member.
  addMember: { kind: "token bucket", rate: 30, period: HOUR, capacity: 10 },
});

// Called from the HTTP layer (httpActions can't use the rate limiter directly —
// it needs db access). Returns { ok, retryAfter } so http.ts can answer 429.
export const checkAgentRateLimit = mutation({
  args: {
    authenticated: v.boolean(),
    key: v.string(), // machine id when authenticated, else client IP
  },
  handler: async (ctx, args) => {
    const name = args.authenticated ? "agentApi" : "agentApiAnon";
    return await rateLimiter.limit(ctx, name, { key: args.key });
  },
});
