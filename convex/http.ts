import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const http = httpRouter();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function post(path: string, handler: (ctx: any, body: any) => Promise<unknown>) {
  http.route({
    path: `/api/${path}`,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      try {
        const body = await request.json();
        return json(await handler(ctx, body));
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
