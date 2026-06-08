import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { auth } from "./auth";
import { hashToken } from "./agentAuth";

const http = httpRouter();

// Convex Auth endpoints (/.well-known/openid-configuration, token exchange, etc.)
auth.addHttpRoutes(http);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Validate the agent's per-machine Bearer token. Returns the machine on success
// or null if the header is missing/invalid (caller responds 401).
async function authenticateAgent(ctx: any, request: Request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const tokenHash = await hashToken(match[1].trim());
  return await ctx.runQuery(api.agentAuth.verifyMachineToken, { tokenHash });
}

function clientIp(request: Request) {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function post(path: string, handler: (ctx: any, body: any, machine?: any) => Promise<unknown>) {
  http.route({
    path: `/api/${path}`,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      // Reject unauthenticated agent calls. Previously the token was accepted but
      // never verified — every /api/* route now requires a valid machine token.
      const machine = await authenticateAgent(ctx, request);

      // Rate limit (defense-in-depth + avoid spamming Convex). Authenticated
      // traffic is keyed per machine with generous headroom; unauthenticated
      // calls are keyed per IP and throttled harder to slow token guessing.
      const rl = await ctx.runMutation(api.rateLimits.checkAgentRateLimit, {
        authenticated: Boolean(machine),
        key: machine ? machine.machineId : clientIp(request),
      });
      if (!rl.ok) {
        return new Response(
          JSON.stringify({ error: "Rate limited. Slow down and retry shortly." }),
          { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil((rl.retryAfter || 1000) / 1000)) } }
        );
      }

      if (!machine) {
        return json({ error: "Unauthorized: missing or invalid agent token. Run `driveos-agent connect`." }, 401);
      }
      try {
        const body = await request.json();
        return json(await handler(ctx, body, machine));
      } catch (err: any) {
        return json({ error: err.message || "Unknown DriveOS agent API error" }, 500);
      }
    }),
  });
}

post("registerMachine", async (ctx, body) => {
  const machineId = await ctx.runMutation(api.drives.registerMachine, body);
  return { success: true, machineId };
});

post("registerDrive", async (ctx, body) => {
  const driveId = await ctx.runMutation(api.drives.register, body);
  return { success: true, driveId };
});

post("startScan", async (ctx, body) => {
  const sessionId = await ctx.runMutation(api.scans.start, body);
  return { success: true, sessionId };
});

post("completeScan", async (ctx, body) => {
  await ctx.runMutation(api.scans.complete, body);
  return { success: true };
});

post("uploadBatch", async (ctx, body) => {
  return await ctx.runMutation(api.files.uploadBatch, body);
});

post("createManifest", async (ctx, body) => {
  const manifestId = await ctx.runMutation(api.archive.createManifest, body);
  return { success: true, manifestId };
});

post("pollPendingJobs", async (ctx, body) => {
  return await ctx.runQuery(api.cleanup.pollPendingJobs, body);
});

post("getJob", async (ctx, body) => {
  const job = await ctx.runQuery(api.cleanup.getJob, body);
  return { success: true, job };
});

post("updateJobStatus", async (ctx, body) => {
  await ctx.runMutation(api.cleanup.updateJobStatus, body);
  return { success: true };
});

post("getQuarantineItem", async (ctx, body) => {
  const item = await ctx.runQuery(api.cleanup.getQuarantineItem, body);
  return { success: true, item };
});

post("markQuarantineRestored", async (ctx, body) => {
  await ctx.runMutation(api.cleanup.markQuarantineRestored, body);
  return { success: true };
});

post("getProject", async (ctx, body) => {
  const project = await ctx.runQuery(api.projects.get, body);
  return { success: true, project };
});

export default http;
