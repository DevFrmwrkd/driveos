import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
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
  return await ctx.runQuery(internal.agentAuth.verifyMachineToken, { tokenHash });
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
      const rl = await ctx.runMutation(internal.rateLimits.checkAgentRateLimit, {
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
      // Fail closed: a machine that isn't linked to a workspace must never write.
      // (Post-migration every machine carries a tenantId; an empty one would
      // otherwise fall into the un-scoped legacy pool.)
      if (!machine.tenantId) {
        return json({ error: "This device isn't linked to a workspace. Reconnect it with `driveos-agent connect`." }, 401);
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

// Every agent write/read is stamped/scoped with the authenticated machine's
// tenantId, so a token for one workspace can never touch another's data.
const scoped = (body: any, machine: any) => ({ ...body, tenantId: machine.tenantId });

post("registerMachine", async (ctx, body, machine) => {
  const machineId = await ctx.runMutation(internal.drives.registerMachine, scoped(body, machine));
  return { success: true, machineId };
});

post("registerDrive", async (ctx, body, machine) => {
  const driveId = await ctx.runMutation(internal.drives.register, scoped(body, machine));
  return { success: true, driveId };
});

post("removeDrive", async (ctx, body, machine) => {
  const result = await ctx.runMutation(internal.drives.removeByVolumeId, scoped(body, machine));
  return { success: true, ...result };
});

post("startScan", async (ctx, body, machine) => {
  const sessionId = await ctx.runMutation(internal.scans.start, scoped(body, machine));
  return { success: true, sessionId };
});

post("completeScan", async (ctx, body, machine) => {
  await ctx.runMutation(internal.scans.complete, scoped(body, machine));
  return { success: true };
});

post("uploadBatch", async (ctx, body, machine) => {
  return await ctx.runMutation(internal.files.uploadBatch, scoped(body, machine));
});

post("createManifest", async (ctx, body, machine) => {
  const manifestId = await ctx.runMutation(internal.archive.createManifest, scoped(body, machine));
  return { success: true, manifestId };
});

post("pollPendingJobs", async (ctx, body, machine) => {
  return await ctx.runQuery(internal.cleanup.pollPendingJobs, scoped(body, machine));
});

post("getJob", async (ctx, body, machine) => {
  const job = await ctx.runQuery(internal.cleanup.getJob, scoped(body, machine));
  return { success: true, job };
});

post("updateJobStatus", async (ctx, body, machine) => {
  await ctx.runMutation(internal.cleanup.updateJobStatus, scoped(body, machine));
  return { success: true };
});

post("getQuarantineItem", async (ctx, body, machine) => {
  const item = await ctx.runQuery(internal.cleanup.getQuarantineItem, scoped(body, machine));
  return { success: true, item };
});

post("markQuarantineRestored", async (ctx, body, machine) => {
  await ctx.runMutation(internal.cleanup.markQuarantineRestoredAgent, scoped(body, machine));
  return { success: true };
});

post("getProject", async (ctx, body, machine) => {
  const project = await ctx.runQuery(internal.projects.getForAgent, scoped(body, machine));
  return { success: true, project };
});

export default http;
