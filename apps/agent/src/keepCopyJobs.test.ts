import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

test("real CLI preserves the final copy and recovers already-completed physical receipts", { timeout: 60_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-keep-jobs-"));
  const media = path.join(root, "media", "04_ASSETS", "MUSIC");
  const agentHome = path.join(root, "agent-home"), quarantineRoot = path.join(root, "quarantine");
  const children = new Set<ChildProcess>();
  const jobs = new Map<string, any>(), receipts = new Map<string, any>();
  const interrupted = new Map<string, any>();
  const dropTerminal = new Set<string>();
  const errors: string[] = [];
  const token = "synthetic-keep-copy-test-token";
  const machineId = "machine-a";
  const bytes = "the last full copy of licensed music";
  const fullHash = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(media, { recursive: true });
  function make(name: string, keepContents?: string, includeProof = true) {
    const source = path.join(media, `${name}.wav`), keep = path.join(media, `${name}-keep.wav`);
    fs.writeFileSync(source, bytes);
    if (keepContents !== undefined) fs.writeFileSync(keep, keepContents);
    const stat = fs.statSync(source);
    const file = { _id: `${name}-file`, path: source, sizeBytes: stat.size, modifiedAtFile: stat.mtimeMs, fullHash, classification: "AUDIO" };
    const proof = { fileId: file._id, keepFileId: `${name}-keep-file`, keepPath: keep, keepMachineId: machineId, fullHash, sizeBytes: stat.size };
    const job: any = { _id: name, action: "quarantine", status: "approved", machineId, files: [file], affectedFileIds: [file._id],
      result: includeProof ? { keepCopyProtocol: 1, keepCopyProofs: [proof] } : {} };
    jobs.set(name, job);
    return { source, keep, file, proof, job };
  }
  const noProof = make("no-proof", bytes, false);
  const missing = make("missing-keep");
  const changed = make("changed-keep", "X".repeat(Buffer.byteLength(bytes)));
  const valid = make("valid-keep", bytes);
  dropTerminal.add(valid.job._id);

  const server = http.createServer(async (request, response) => {
    const answer = (status: number, body: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.headers.authorization !== `Bearer ${token}` || payload.keepCopyProtocol !== 1)
        return answer(400, { error: "Keep-copy capability and fixture authentication are required" });
      if (request.url === "/api/pollPendingJobs") return answer(200, [...jobs.values()]
        .filter(job => job.status === "approved" || job.recover)
        .map(({ claimToken: _token, ...job }) => job));
      if (request.url !== "/api/updateJobStatus") return answer(404, { error: "Unexpected fixture endpoint" });
      const job = jobs.get(payload.jobId);
      if (!job || !payload.claimToken) return answer(400, { error: "Unknown fixture claim" });
      if (payload.status === "running") {
        if (job.status === "approved" || job.recover) { job.status = "running"; job.claimToken = payload.claimToken; delete job.recover; }
        if (job.status !== "running" || job.claimToken !== payload.claimToken) return answer(200, { claimed: false, reason: "lease_lost" });
        return answer(200, { claimed: true, leaseExpiresAt: Date.now() + 120_000 });
      }
      if (job.status !== "running" || job.claimToken !== payload.claimToken) return answer(200, { claimed: false, reason: "lease_lost" });
      if (dropTerminal.delete(job._id)) {
        interrupted.set(job._id, payload);
        return answer(503, { error: "Simulated stop after the physical operation" });
      }
      job.status = payload.status;
      receipts.set(job._id, payload);
      return answer(200, { claimed: true });
    } catch (error) { errors.push(String(error)); answer(500, { error: String(error) }); }
  });
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("close", () => resolve()); child.kill();
    })));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  async function agent(args: string[]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), ...args], {
      cwd: root, env: { ...process.env, DRIVEOS_AGENT_HOME: agentHome, DRIVEOS_CONVEX_URL: url },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child); let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 45_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 0, output); return output;
    } finally { clearTimeout(timeout); children.delete(child); }
  }
  await agent(["init", "--machine", machineId, "--owner", "keep@driveos.test", "--convex", url,
    "--auth-token", token, "--roots", path.join(root, "media"), "--central-quarantine", "--quarantine", quarantineRoot]);
  const first = await agent(["run-jobs"]);
  for (const entry of [noProof, missing, changed]) {
    assert.equal(entry.job.status, "failed", first);
    assert.equal(fs.readFileSync(entry.source, "utf8"), bytes);
    assert.equal(receipts.get(entry.job._id).quarantineFiles.length, 0);
  }
  assert.equal(valid.job.status, "running", first);
  const moved = interrupted.get(valid.job._id)?.quarantineFiles[0];
  assert.ok(moved && !fs.existsSync(valid.source));
  assert.ok(path.resolve(moved.quarantinePath).startsWith(path.resolve(quarantineRoot) + path.sep));
  assert.equal(fs.readFileSync(moved.quarantinePath, "utf8"), bytes);
  fs.unlinkSync(valid.keep);
  valid.job.result = {}; valid.job.recover = true;
  const recovery = await agent(["run-jobs"]);
  assert.equal(valid.job.status, "completed", recovery);
  assert.equal(receipts.get(valid.job._id).quarantineFiles[0].quarantinePath, moved.quarantinePath);

  const purgeItem = { quarantineItemId: "quarantine-valid", quarantinePath: moved.quarantinePath,
    fileId: valid.file._id, originalPath: valid.source, sizeBytes: valid.file.sizeBytes, fullHash,
    requiresKeepCopy: true, keepCopyProof: valid.proof };
  const missingPurge = { _id: "purge-missing-keep", action: "purge", status: "approved", machineId, files: [],
    result: { keepCopyProtocol: 1, purgeItems: [purgeItem] } };
  jobs.set(missingPurge._id, missingPurge);
  const rejectedPurge = await agent(["run-jobs"]);
  assert.equal(missingPurge.status, "failed", rejectedPurge);
  assert.deepEqual(receipts.get(missingPurge._id).result.purgedItemIds, []);
  assert.equal(fs.readFileSync(moved.quarantinePath, "utf8"), bytes);

  fs.writeFileSync(valid.keep, bytes);
  const purge: any = { ...missingPurge, _id: "purge-valid", status: "approved", result: { keepCopyProtocol: 1, purgeItems: [purgeItem] } };
  jobs.set(purge._id, purge); dropTerminal.add(purge._id);
  const purged = await agent(["run-jobs"]);
  assert.equal(purge.status, "running", purged);
  assert.equal(fs.existsSync(moved.quarantinePath), false);
  assert.equal(fs.readFileSync(valid.keep, "utf8"), bytes);
  fs.unlinkSync(valid.keep);
  purge.result = { purgeItems: [{ ...purgeItem, keepCopyProof: undefined }] }; purge.recover = true;
  const purgeRecovery = await agent(["run-jobs"]);
  assert.equal(purge.status, "completed", purgeRecovery);
  assert.deepEqual(receipts.get(purge._id).result.purgedItemIds, [purgeItem.quarantineItemId]);
  assert.deepEqual(errors, []);
});
