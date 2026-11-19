import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

test("real CLI batches 300 quarantine/purge files within the API budget and retries 429s", { timeout: 60_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-job-batch-"));
  const media = path.join(root, "media", "06_RENDERS_CACHE");
  const agentHome = path.join(root, "agent-home");
  const quarantineRoot = path.join(root, "quarantine");
  const token = "synthetic-loopback-batch-token";
  const children = new Set<ChildProcess>();
  const jobs = new Map<string, any>();
  const receipts = new Map<string, any>();
  const requests: { endpoint: string; jobId?: string; status?: string }[] = [];
  const failures: string[] = [];
  const rejectedAt = new Map<string, number>();
  const retriedAt = new Map<string, number>();
  let server: http.Server | undefined;
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("close", () => resolve());
      child.kill();
    })));
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(media, { recursive: true });
  const files = Array.from({ length: 300 }, (_, index) => {
    const filename = path.join(media, `preview-${index}.dat`);
    fs.writeFileSync(filename, `original cache content ${index}`);
    const stats = fs.statSync(filename);
    return { _id: `file-${index}`, path: filename, classification: "CACHE", isGenerated: true,
      sizeBytes: stats.size, modifiedAtFile: stats.mtimeMs };
  });
  jobs.set("quarantine-batch", { _id: "quarantine-batch", action: "quarantine", status: "approved",
    affectedFileIds: files.map(file => file._id), files, result: {} });

  function json(response: http.ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }
  server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const endpoint = request.url || "";
      requests.push({ endpoint, jobId: payload.jobId, status: payload.status });
      if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "Invalid fixture token" });
      // Deliberately stricter than the real 240-request burst. The previous
      // per-file renewal loop cannot complete this otherwise-small batch.
      if (requests.length > 24) {
        response.setHeader("Retry-After", "1");
        return json(response, 429, { error: "Synthetic batch request budget exhausted" });
      }
      if (endpoint === "/api/pollPendingJobs") {
        if (payload.leaseProtocol !== 1) return json(response, 400, { error: "Lease protocol required" });
        return json(response, 200, [...jobs.values()].filter(job => job.status === "approved"));
      }
      if (endpoint !== "/api/updateJobStatus") return json(response, 404, { error: "Unexpected fixture endpoint" });
      const job = jobs.get(payload.jobId);
      if (!job) return json(response, 404, { error: "Unknown fixture job" });
      if (typeof payload.claimToken !== "string" || payload.claimToken.length < 20) return json(response, 400, { error: "Claim token required" });
      const injection = job._id === "quarantine-batch"
        ? payload.status === "running" && job.status === "approved" ? "claim"
          : payload.status === "completed" ? "terminal" : undefined
        : undefined;
      if (injection && !rejectedAt.has(injection)) {
        rejectedAt.set(injection, Date.now());
        response.setHeader("Retry-After", "1");
        return json(response, 429, { error: `Retry synthetic ${injection} request` });
      }
      if (injection && !retriedAt.has(injection)) retriedAt.set(injection, Date.now());
      if (payload.status === "running") {
        if (job.status === "approved") { job.status = "running"; job.claimToken = payload.claimToken; }
        else if (job.status !== "running" || job.claimToken !== payload.claimToken)
          return json(response, 200, { claimed: false, reason: "another_attempt" });
        return json(response, 200, { claimed: true, claimToken: job.claimToken, leaseExpiresAt: Date.now() + 120_000 });
      }
      if (job.status !== "running" || job.claimToken !== payload.claimToken)
        return json(response, 200, { claimed: false, reason: "lease_lost" });
      job.status = payload.status;
      receipts.set(job._id, payload);
      return json(response, 200, { claimed: true });
    } catch (error) {
      failures.push(String(error));
      return json(response, 500, { error: String(error) });
    }
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  async function agent(args: string[]) {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, windowsHide: true,
      env: { ...process.env, DRIVEOS_AGENT_HOME: agentHome, DRIVEOS_CONVEX_URL: baseUrl }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const timer = setTimeout(() => child.kill(), 50_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 0, output.slice(-8000));
      return output;
    } finally { clearTimeout(timer); children.delete(child); }
  }
  await agent(["init", "--machine", "Batch-QA", "--owner", "batch@driveos.test", "--convex", baseUrl,
    "--auth-token", token, "--roots", path.dirname(media), "--central-quarantine", "--quarantine", quarantineRoot]);
  const quarantineOutput = await agent(["run-jobs"]);
  const quarantine = receipts.get("quarantine-batch");
  assert.equal(jobs.get("quarantine-batch").status, "completed", quarantineOutput);
  assert.equal(quarantine?.quarantineFiles.length, 300);
  assert.deepEqual(quarantine.result.failures, []);
  assert.equal(quarantine.result.moved, 300);
  assert.ok(requests.length < 10, `A 300-file quarantine used ${requests.length} API requests`);
  assert.deepEqual([...rejectedAt.keys()].sort(), ["claim", "terminal"]);
  for (const kind of ["claim", "terminal"]) assert.ok(retriedAt.get(kind)! - rejectedAt.get(kind)! >= 900, `${kind} retry must honor Retry-After`);
  for (const [index, file] of files.entries()) {
    assert.equal(fs.existsSync(file.path), false);
    const moved = quarantine.quarantineFiles.find((receipt: any) => receipt.fileId === file._id);
    assert.ok(path.resolve(moved.quarantinePath).startsWith(path.resolve(quarantineRoot) + path.sep));
    assert.equal(fs.readFileSync(moved.quarantinePath, "utf8"), `original cache content ${index}`);
  }
  jobs.set("purge-batch", { _id: "purge-batch", action: "purge", status: "approved", files: [],
    affectedFileIds: files.map(file => file._id), result: { purgeItems: quarantine.quarantineFiles.map((file: any) =>
      ({ quarantineItemId: `quarantine-${file.fileId}`, quarantinePath: file.quarantinePath })) } });
  const purgeOutput = await agent(["run-jobs"]);
  const purge = receipts.get("purge-batch");
  assert.equal(jobs.get("purge-batch").status, "completed", purgeOutput);
  assert.equal(purge?.result.purgedItemIds.length, 300);
  assert.deepEqual(purge.result.failures, []);
  for (const moved of quarantine.quarantineFiles) assert.equal(fs.existsSync(moved.quarantinePath), false);
  assert.ok(requests.length < 10, `Both 300-file jobs used ${requests.length} API requests`);
  assert.deepEqual(failures, []);
});
