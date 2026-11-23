# Scan & Analyze verification

Verified on Windows against a disposable local Convex backend on 23 November 2026.
Production services and published installers were not changed.

## Behavior

- One explicit desktop scan finishes every configured root and progressive pass,
  then requests duplicate and cleanup analysis once. Dashboard scan jobs and the
  one-shot CLI scan also request analysis after a successful scan.
- Classification stays automatic. Analysis generates suggestions; it creates no
  quarantine, restore, or permanent-delete jobs.
- Individual cleanup and duplicate batches display the actual paths and require
  an explicit approval checkbox before queuing quarantine. Permanent deletion
  keeps its admin restriction and typed `DELETE` confirmation.
- Background scan scheduling retains its existing policy. The feature does not
  enable the global automatic-analysis setting or automatic cleanup.
- Replayed scan receipts do not schedule more work. Concurrent requests share an
  analyzer. A changed catalog permits one bounded follow-up; continuing changes,
  oversized catalogs, stopped workers, and analysis failures remain visible.
- Unchanged scans reuse completed current results for five minutes. Rebuilds
  preserve the tenant cooldown and run automatically when due. Project state,
  health scores, and cleanup-rule changes invalidate results, including any
  analysis already in flight. Cached validation preserves worker timestamps.
- Pending scans remain visible across drives and machines. Only a newer attempt
  on the same owning drive supersedes its old failure.
- Successful desktop recovery clears an older dashboard scan error only when a
  newer clean scan of the same machine and drive has fresh successful analysis
  or a current cached-result validation covering that scan.
- Approval dialogs share a body portal, independent of scrolling and animated
  pages. Cleanup exposes one Review & quarantine action. Dashboard scan and
  project controls appear once, with maintenance shortcuts retained.

## Automated checks

All existing suites and new regressions passed. To keep memory use low, local
Node tests ran sequentially rather than launching the full suite in parallel.

| Check | Result |
| --- | --- |
| Shared classification and protection rules | 15 passed |
| Agent tests | 117 passed |
| Backend and other regression scripts | 89 passed, including 32 analysis tests |
| Desktop bridge and dashboard approval/status tests | 25 passed |
| Shared modal placement and control cleanup regressions | 4 passed |
| Total regression tests | 250 passed |
| Actual bundled agent | 14 fixture checks plus browser-approved quarantine and restore passed |
| Convex, desktop, and web TypeScript checks | Passed |
| Production dashboard build | Passed |
| Git whitespace check | Passed |

The approval and desktop acknowledgment tests also failed against the 1.2.3
baseline before the fixes. Desktop recovery regressions failed before the final
status fix and passed afterward. The new portal, duplicate-control, per-drive
status, and unchanged-analysis regressions also failed before their fixes.

## Real end-to-end checks

`npm run test:local:scan-analysis` exercises a running disposable loopback backend
with automatic background analysis disabled. All 16 checks passed:

- One `scan-now` across two roots automatically publishes classifications, exact
  duplicate results, and cleanup recommendations without another analysis call.
- Files and checksums remain unchanged, and no move/delete jobs appear, including
  when the agent polls before any cleanup approval.
- Missing authentication, malformed requests, foreign machines and workspaces,
  repeated receipts, and unsuccessful scans are handled safely.
- A dashboard scan request runs on its owning agent and analyzes new files.
- Background sync stays scan-only; direct scans analyze; pause blocks the flow.
- Unchanged scans preserve the analyzer run ID and actual worker timestamps.
  Changed scans keep their intent while waiting for the five-minute cooldown.
- Real pending and failed jobs on another machine remain visible after retrying
  a different drive; retrying the affected drive clears only its own failure.
- Marking a project delivered and changing cleanup rules invalidates recent
  cached results, then the delayed real analyzer publishes updated suggestions.
- Explicit quarantine, restore, and permanent deletion execute on the actual
  test files. Checksum checks preserve protected media and remaining copies.

The local browser also exercised the dashboard Scan & Analyze button across two
drives through queued scans, real agent execution, and visible Analysis complete.
Cleanup and duplicate dialogs stayed disabled until approval; cancellation
queued nothing. With 20 duplicate groups, dialogs stayed fully inside the
720-pixel viewport at both scroll offsets 474 and 8,224 (dialog top 168, bottom
552). Cleanup preview stayed inside the viewport too. Dashboard showed one
Scan & Analyze and one Create Project; Cleanup showed one Review & quarantine.
A browser-approved duplicate moved through the actual bundled agent into
quarantine and restored with its original checksum. Typed `DELETE` enabled the
permanent-delete button; that browser deletion was cancelled. Browser error logs
were empty.

The accelerated local run used a QA-only timer helper copied from
`scripts/fixtures/qaScanAnalysisReview.ts.template` into the disposable backend.
The harness first checked the actual scheduled time against the five-minute
deadline, then advanced that tenant's pending timer; production claiming,
analysis, and publication still ran normally. The helper is outside the deployed
source tree. Without the explicit `DRIVEOS_TEST_ANALYSIS_FIXTURE` selection, the
harness waits through the real cooldown.

## Rollout and limits

This branch requires coordinated backend/dashboard deployment and updated agent
installers. Existing 1.2.3 installers retain their prior behavior until updated.
No installer version bump or release is included here.

The existing analysis limit remains 250,000 catalog files by default. Exceeding
the limit reports failure instead of starting an unbounded catalog rebuild.
Dashboard Scan All creates per-drive jobs. Unchanged recent results are reused;
changed scans share queued work during the cooldown.

Windows execution is verified locally. Linux and macOS execution has not been
repeated for this branch. Draft commits use `[skip ci]` to defer
hosted regression jobs. Before merging, push a commit without that instruction
and let the required hosted checks run; marking this draft ready alone does not
start them under the existing workflow configuration.
