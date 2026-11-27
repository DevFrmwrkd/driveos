# Implementation Spec: restore-triggered duplicate refresh

Date: 2026-11-27. Separate follow-up to merged [PR #66](https://github.com/DevFrmwrkd/driveos/pull/66).

## Baseline and decision

The supplied worktree is now on `codex/restore-refresh-followup`, based on fetched `origin/main` commit `600334b`. Its prior `5d78e12` checkout already contained PR #66's restore fix and local-test cooldown adjustment; the merged baseline additionally contains the CI checkout-ref fix. Preserve that baseline and unrelated changes.

Choose **tenant-deduplicated full analysis after each confirmed restore of an existing catalog file**, using the explicit-analysis worker. Restore is user-requested work: use the existing five-minute explicit cooldown, independently of `DRIVEOS_AUTO_ANALYSIS`, rather than the automatic daily interval. In a stable supported catalog, the group returns without another scan, analysis request, or manual reopen.

Evidence: `cleanup.ts::rejoinDuplicateCluster` returns if the cluster is missing; `duplicates.ts::runDuplicateDetection` prunes a hash with only one live copy. `finishRestore` also does not advance the publication generation, so an in-flight pre-restore snapshot can overwrite a repaired group. `scans.ts` already owns tenant scheduling, run fencing, cooldowns, bounded explicit workers, and publication. A bounded affected-group refresh would require a new tenant/hash index on the largest table plus separate completeness, concurrency, and publication handling; existing cluster member IDs cannot discover a deleted group reliably. Reuse the established analyzer for this follow-up.

## Files and contracts

| Path | Change |
| --- | --- |
| `convex/schema.ts` | Add optional restore intent fields below; extend `analysisMode` with `"restore"`. No new table or index. |
| `convex/catalogAnalysis.ts` | Add restore-intent predicate; extend the private state interface with restore versions. Keep existing generation semantics. |
| `convex/scans.ts` | Export an ordinary transaction helper for restore requests; generalize enqueue, finish, release, recovery, and explicit-request coalescing to include restore intent. |
| `convex/cleanup.ts` | Call that helper from successful `finishRestore`, after updating an existing tenant file. Preserve lease/confirmation validation and current rejoin logic. |
| `convex/duplicates.ts` | Preserve user-decision rows during stale-cluster deletion; retain existing upsert/reopen rules. |
| `scripts/duplicate-restore.test.mjs` | Extend fixture dispatch/scheduler and add the actual timing, lease, isolation, and decision regressions. |
| `scripts/catalog-analysis.test.mjs` | Cover restore intent across existing scheduler/fencing paths and limits. |
| `scripts/test-local-flows.mjs` | Exercise intervening analysis before real restore, then wait for restore-triggered publication; match recreated groups by hash/members. |
| `README.md` | Briefly document delayed restore refresh and the longer local timing regression. Regenerate `_generated` files only if codegen changes them. |

```ts
// Optional analysisState fields; absent versions/budgets mean zero.
restoreAnalysisRequestVersion?: number;
restoreAnalysisResolvedVersion?: number;
restoreAnalysisFollowUps?: number; // 0 or 1, matching scan follow-up policy
// Existing analysisMode union gains "restore".

// Ordinary server helper in scans.ts, NOT a registered public endpoint.
export async function requestRestoreAnalysis(
  ctx: MutationCtx,
  tenantId: string,
): Promise<void>;
```

Use the existing generated `MutationCtx` type. The helper receives trusted tenant scope from the accepted job, never from an agent result. Existing public/HTTP restore arguments and responses stay compatible. No agent or UI change is required; `scans.analysisStatus` supplies queued/running/completed/stale/failed state.

## Transaction and scheduler behavior

1. Only the accepted successful leased restore completion, with the persisted job's quarantine item confirmed in `restoredQuarantineIds`, reaches `finishRestore`. Keep its file revision update, exact-cluster rejoin, and audit. For an existing tenant file, call `requestRestoreAnalysis` in that same mutation. The helper advances `catalogGeneration`/`dirtyCount` once via `invalidateAnalysisInputs`, recovers a stopped owner using the existing safety rules, increments the restore request version once, and sets its follow-up budget to one. Apply this for existing and missing clusters and for files without a full hash: restore changes both duplicate and recommendation inputs.
2. If no owner exists, queue `runManualAnalysis` with mode `"restore"`, at `max(1_000, lastRunAt + 300_000 - now)` milliseconds. This retains intent through cooldown. Use its existing `MANUAL_ANALYSIS_MAX_FILES` cap (default 250,000, configured/clamped as today). Do not call public `requestAnalysis`, which can refuse a cooldown request, or enqueue an extra per-file trampoline.
3. Share a pending manual/scan/restore worker. Promote an unclaimed pending automatic timer by canceling it and queuing one explicit worker at the same explicit deadline; preserve all outstanding intent versions. Never replace a claimed/in-progress owner or violate the canceled-owner grace period. A running worker must finish under its original run ID; the advanced generation prevents it publishing a pre-restore snapshot as current.
4. Generalize the existing scan-intent finish/release logic. A successful **current-generation** publication settles all outstanding scan and restore versions, clears dirty state through existing generation checks, and publishes both duplicate and recommendation results. A successful stale completion with either pending budget schedules **one shared** explicit follow-up and decrements both outstanding positive budgets together. Prefer restore mode while restore intent remains. Do not queue separate scan and restore follow-ups.
5. On failure, exhausted stale follow-up, or safe stopped-owner recovery, settle the affected versions as terminally handled, retain dirty state/generation mismatch, and expose failed/stale status and an accurate error. Settled does not mean successful. Suppress automatic requeue for these explicit outcomes, including restore mode, so neither pending intent nor the automatic switch creates an endless retry loop. A new distinct successful restore can issue a new version/budget. Preserve automatic daily scheduling behavior for unrelated automatic work.
6. Keep at most one scheduled/running analyzer per tenant, with at most one stale-generation follow-up for the currently coalesced explicit intents. Many restores before a run starts increment receipts but share its one timer. Old run-ID completions cannot settle newer requests or release their owner. Repeated terminal job reports already exit as `already_finished` before side effects: verify they add no generation, request, audit, or scheduled work.

The immediate rejoin remains useful internal bookkeeping, but must not mark the whole catalog current. Existing readers intentionally hide cached duplicate/recommendation aggregates until the scheduled analysis validates the new generation; update immediate-visibility tests accordingly. A physical restore remains successful if its asynchronous analyzer later fails or exceeds the cap; report analysis failure without undoing the restore or silently publishing partial results. An absent catalog file retains current item/audit behavior and queues no fabricated file/group.

## Decisions, isolation, and errors

- In `duplicates.deleteClusters`, retain rows marked `USER_RESOLUTION`, ignored rows, and legacy decisions identified by `unmarkedUserDecision`; stamp unmarked retained decisions as `USER_RESOLUTION` using existing rules. Otherwise analysis between quarantine and restore destroys an intentional/ignored choice. Cleanup-resolved singleton rows must still be deleted so the reported regression genuinely exercises recreation. Existing `upsertClusters` refreshes retained membership/totals without reopening user decisions. No attempt to reconstruct decisions already deleted before this change.
- Preserve tenant filters on all state, file, quarantine, and cluster access. The scheduled analyzer spans that tenant's catalog, as today; execution authority remains the persisted restore job's machine and file/item association. Do not use caller-supplied cluster IDs, hash, machine, tenant, or unrelated confirmation IDs to request refresh or expand restoration.
- Failed/unconfirmed restores, rejected/wrong/expired lease tokens, foreign tenant/machine/job reports, and repeated completion reports must not advance generation or request refresh. Keep the existing authenticated HTTP scope injection and metadata-only confirmation rejection.
- Preserve the existing action cap, cleanup job file limits, and one-owner scheduling policy. Hashless/quick-hash files use normal detection rules; restore must not invent exact duplicates. A lone live file produces no open group. Concurrent catalog changes remain fenced and receive only the bounded follow-up above.

## Required regression and verification

Extend the real-handler restore fixture with `scans`, `recommendations`, scheduler/system job state, a controlled clock, and scheduled-action dispatch, following `catalog-analysis.test.mjs`. Do not replace the behavior under test with an analysis stub. The catalog fixture stubs authorization/job helpers, so keep lease and scope assertions in the restore fixture.

- With automatic analysis disabled: leased quarantine -> real duplicate analysis deletes the cleanup-resolved singleton cluster -> confirm original cluster absent and no visible group -> leased successful restore -> run only work scheduled by restore -> assert exactly one exact group, both member IDs and locations, `fileCount: 2`, `totalBytes: 20`, `wastedBytes: 10`. Allow a recreated cluster ID. Re-analysis must still leave exactly one group.
- Cover restore with an existing group and with three copies; repeated completion; failed restore after cluster deletion; missing file/hash; tenant separation (including identical hashes); wrong machine/job/item/token and stale lease; one remaining live file. Assert no foreign state changes and no refresh side effects on rejected reports.
- Put intervening analysis into ignored, intentional, and legacy decision sequences. Verify those decisions survive pruning, restore, and scheduled analysis while factual membership/totals recover.
- Scheduler tests: absent/legacy state; cooldown boundary; multiple restores sharing one pending worker; pending automatic promotion; claimed older generation plus restore; stale old completion; simultaneous scan/restore intent consuming one shared follow-up; failure/exhaustion/recovery; max-files failure; automatic enabled/disabled. Assert actual scheduled deadline, owner/run IDs, request versions, generation publication, and bounded queue count.

Update the existing local duplicate scenario: after real quarantine, force a **new** `scans.requestAnalysis` before requesting restore, retrying only its recognized cooldown/active-owner responses until accepted. Assert `scheduled: true`, then wait for `lastRunAt`/`completedAt` to advance and `completed` + `catalogCurrent`; merely observing old completed status or running an unchanged scan can reuse old results. Confirm `duplicates.getCluster(oldId)` is null and no matching open hash remains. Request restore and run the actual agent; make **no scan/analysis/reopen call after restore**. Wait for the restore-triggered completed/current publication and find exactly one group by type/hash and original member IDs, not original cluster ID. Check locations/count/byte totals, original-file checksum, and quarantine-file removal.

Earlier restores in this local script will also request analysis now. Explicitly wait for completed/current state before later steps that consume cached recommendations or duplicate groups. Keep PR #66's accepted manual-request refusal messages. Use the 330-second analysis wait (with a receipt proving new work where needed), not the generic 30-second poll. Each pre-restore cooldown retry also needs a bounded timeout and immediate failure on unexpected errors. Wait through real cooldowns; the existing acceleration template is scoped to a different QA tenant and cannot be reused unchanged.

Verify implemented code on a **new disposable, auth-configured loopback backend**, with synthetic media and fresh storage. Follow the current README local-test contract. Use a separate temporary Convex app/env for deployment, local JWT/JWKS and loopback `SITE_URL`; set backend `DRIVEOS_AUTO_ANALYSIS=false`. Deploy this worktree's updated sources, without QA helpers in production sources, hosted deployment changes, or rewriting owner `.env.local`. Keep secrets out of command output and committed evidence; stop only the backend started for this verification.

```powershell
node --test scripts/duplicate-restore.test.mjs scripts/catalog-analysis.test.mjs
npm test
npx tsc --noEmit -p convex
# After deploying the updated code to the disposable loopback backend:
$env:DRIVEOS_TEST_URL = 'http://127.0.0.1:3210'
$env:DRIVEOS_TEST_SITE_URL = 'http://127.0.0.1:3211'
npm run test:local
git diff --check
```

Record actual exit codes, test counts, deployed revision/source identity, backend setup and automatic-analysis flag, and paths to fixture summary/logs. Demonstrate that the new timing assertion fails against the merged baseline and passes with the fix. Keep this work separate from PR #66 and send implementation plus command evidence to QA.

## Architect inspection status

Verified merged PR metadata and fetched `origin/main`; reconciled the clean supplied worktree onto `600334b` on the separate follow-up branch. Ran `node --test scripts/duplicate-restore.test.mjs scripts/catalog-analysis.test.mjs`: exit 0, 40 passed, zero failed on the unchanged application baseline. Ran `git diff --check`: exit 0. No application implementation, new regression, full `npm test`, or local-backend run was performed at the architecture stage; developer and QA must run the checks above against the completed change.
