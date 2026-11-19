import test from "node:test";
import assert from "node:assert/strict";
import { JobLeaseClient, RateLimitedError, withRateLimitBackoff } from "./jobLeaseClient.js";

test("thousands of fast file operations use the claim without per-file heartbeats", async () => {
  let clock = 0, renewals = 0;
  const lease = new JobLeaseClient(async () => { renewals++; return { claimed: true }; }, { now: () => clock });
  for (let file = 0; file < 4000; file++) { clock++; await lease.ensureValid(); }
  assert.equal(renewals, 0);
  clock = 20_000;
  await lease.ensureValid();
  assert.equal(renewals, 1);
  for (let file = 0; file < 4000; file++) await lease.ensureValid();
  assert.equal(renewals, 1);
});

test("the timer and simultaneous operation checks share a single renewal", async () => {
  let clock = 0, renewals = 0;
  let finish!: () => void;
  const lease = new JobLeaseClient(async () => { renewals++; await new Promise<void>(resolve => { finish = resolve; }); return { claimed: true }; }, { now: () => clock });
  clock = 21_000;
  const pending = Promise.all(Array.from({ length: 30 }, () => lease.ensureValid()));
  assert.equal(renewals, 1);
  finish(); await pending;
  assert.equal(renewals, 1);
});

test("a throttled heartbeat respects Retry-After and preserves its attempt", async () => {
  let clock = 0, requests = 0;
  const delays: number[] = [];
  const lease = new JobLeaseClient(async () => {
    if (++requests === 1) throw new RateLimitedError("busy", 2);
    return { claimed: true };
  }, { now: () => clock, pause: async milliseconds => { delays.push(milliseconds); clock += milliseconds; } });
  clock = 20_000;
  await lease.ensureValid(); await lease.ensureValid();
  assert.deepEqual(delays, [2000]); assert.equal(requests, 2);
});

test("lost claims stop operations and repeated throttling has a bounded retry count", async () => {
  let clock = 0, renewals = 0;
  const lease = new JobLeaseClient(async () => { renewals++; return { claimed: false, reason: "lease_lost" }; }, { now: () => clock });
  clock = 120_000;
  await assert.rejects(lease.ensureValid(), /lease_lost/);
  await assert.rejects(lease.ensureValid(), /lease_lost/);
  assert.equal(renewals, 1);
  let requests = 0, pauses = 0;
  await assert.rejects(withRateLimitBackoff(async () => { requests++; throw new RateLimitedError("busy", 1); }, async () => { pauses++; }), /busy/);
  assert.equal(requests, 4); assert.equal(pauses, 3);
});

test("a terminal report retries after throttling without re-sending a fresh heartbeat", async () => {
  let clock = 0, renewals = 0, reports = 0;
  const lease = new JobLeaseClient(async () => { renewals++; return { claimed: true }; }, { now: () => clock });
  clock = 20_000;
  await withRateLimitBackoff(async () => {
    await lease.ensureValid();
    if (++reports === 1) throw new RateLimitedError("busy", 1);
  }, async milliseconds => { clock += milliseconds; });
  assert.equal(renewals, 1); assert.equal(reports, 2);
});
