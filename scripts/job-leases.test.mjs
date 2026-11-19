import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Compile the pure policy in memory so these tests also run on Node 22 releases
// that do not yet load TypeScript files directly.
const policySource = await readFile(new URL("../convex/jobLease.ts", import.meta.url), "utf8");
const policyJs = ts.transpileModule(policySource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const {
  decideJobLease,
  jobAvailableToAgent,
  jobLeaseExpired,
  JOB_LEASE_MS,
  withoutClaimToken,
} = await import(`data:text/javascript;base64,${Buffer.from(policyJs).toString("base64")}`);

const now = 1_800_000_000_000;
const firstToken = "61ce61d1-f8e2-4fbe-afb8-ef454b162ed3";
const nextToken = "22c3f62a-11eb-4bf7-82b7-676cfbaec203";
const queued = { status: "approved", updatedAt: now, leaseRequired: true };
const first = decideJobLease(queued, "running", firstToken, now);
const running = { ...queued, status: "running", ...first.patch };

test("new jobs require an upgraded agent; legacy jobs remain compatible", () => {
  assert.equal(jobAvailableToAgent(queued, now), false);
  assert.equal(jobAvailableToAgent(queued, now, 1), true);
  assert.equal(decideJobLease(queued, "running", undefined, now).accepted, false);
  const legacy = { status: "queued", updatedAt: now };
  assert.equal(jobAvailableToAgent(legacy, now), true);
  assert.equal(decideJobLease(legacy, "running", undefined, now).accepted, true);
});

test("a claim excludes competing attempts until its lease expires", () => {
  assert.equal(first.accepted, true);
  assert.equal(first.patch.attempts, 1);
  assert.equal(first.patch.leaseExpiresAt, now + JOB_LEASE_MS);
  assert.equal(decideJobLease(running, "running", nextToken, now + 1).accepted, false);
  assert.equal(jobAvailableToAgent(running, now + JOB_LEASE_MS - 1, 1), false);
  assert.equal(jobAvailableToAgent(running, now + JOB_LEASE_MS, 1), true);
});

test("renewal preserves the attempt and may reclaim its own expired lease before takeover", () => {
  const renewed = decideJobLease(running, "running", firstToken, now + JOB_LEASE_MS + 1);
  assert.equal(renewed.accepted, true);
  assert.equal(renewed.renewing, true);
  assert.equal(renewed.patch.attempts, 1);
  assert.equal(renewed.patch.leaseExpiresAt, now + 2 * JOB_LEASE_MS + 1);
});

test("takeover increments the attempt and fences old heartbeats and terminal receipts", () => {
  const takeoverAt = now + JOB_LEASE_MS;
  const takeover = decideJobLease(running, "running", nextToken, takeoverAt);
  assert.equal(takeover.accepted, true);
  assert.equal(takeover.patch.attempts, 2);
  const reclaimed = { ...running, ...takeover.patch };
  assert.equal(decideJobLease(reclaimed, "running", firstToken, takeoverAt + 1).accepted, false);
  assert.equal(decideJobLease(reclaimed, "completed", firstToken, takeoverAt + 1).accepted, false);
  assert.equal(decideJobLease(reclaimed, "failed", undefined, takeoverAt + 1).accepted, false);
  assert.equal(decideJobLease(reclaimed, "completed", nextToken, takeoverAt + 1).accepted, true);
});

test("expired terminal receipts must renew before completion", () => {
  assert.equal(decideJobLease(running, "completed", firstToken, now + JOB_LEASE_MS).accepted, false);
  const renewed = decideJobLease(running, "running", firstToken, now + JOB_LEASE_MS);
  assert.equal(decideJobLease({ ...running, ...renewed.patch }, "completed", firstToken, now + JOB_LEASE_MS).accepted, true);
});

test("legacy running jobs require manual review because age cannot prove the old agent stopped", () => {
  const legacy = { status: "running", updatedAt: now };
  const aWeekLater = now + 7 * 86400_000;
  assert.equal(jobLeaseExpired(legacy, aWeekLater), false);
  assert.equal(jobAvailableToAgent(legacy, aWeekLater, 1), false);
  assert.equal(jobAvailableToAgent(legacy, aWeekLater), false);
  const claim = decideJobLease(legacy, "running", firstToken, aWeekLater);
  assert.equal(claim.accepted, false);
  assert.equal(claim.reason, "legacy_running_requires_review");
});

test("unclaimed and finished jobs cannot accept terminal receipts", () => {
  assert.equal(decideJobLease(queued, "completed", firstToken, now).accepted, false);
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.equal(decideJobLease({ ...running, status }, "running", nextToken, now + JOB_LEASE_MS).accepted, false);
    assert.equal(decideJobLease({ ...running, status }, "completed", firstToken, now).accepted, false);
  }
});

test("claim secrets are not returned in dashboard or pending-job records", () => {
  assert.equal("claimToken" in withoutClaimToken(running), false);
  assert.equal(withoutClaimToken(running).leaseExpiresAt, running.leaseExpiresAt);
});

test("missing or malformed attempt tokens cannot take ownership of a leased job", () => {
  for (const token of [undefined, "", "too-short", "a".repeat(201), "this-token-contains-spaces "]) {
    assert.equal(decideJobLease(running, "running", token, now + JOB_LEASE_MS).accepted, false);
    assert.equal(decideJobLease(running, "completed", token, now).accepted, false);
  }
});
