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
- Successful desktop recovery clears an older dashboard scan error only when a
  newer clean scan of the same machine and drive has fresh successful analysis.

## Automated checks

All existing suites and new regressions passed. To keep memory use low, local
Node tests ran sequentially rather than launching the full suite in parallel.

| Check | Result |
| --- | --- |
| Shared classification and protection rules | 15 passed |
| Agent tests | 117 passed |
| Backend and other regression scripts | 82 passed, including 25 analysis tests |
| Desktop bridge and dashboard approval/status tests | 21 passed |
| One-shot CLI regression against the actual bundled desktop agent | 31 passed |
| Convex, desktop, and web TypeScript checks | Passed |
| Production dashboard build and desktop bundle build | Passed |
| Git whitespace check | Passed |

The approval and desktop acknowledgment tests also failed against the 1.2.3
baseline before the fixes. Desktop recovery regressions failed before the final
status fix and passed afterward.

## Real end-to-end checks

`npm run test:local:scan-analysis` exercises a running disposable loopback backend
with automatic background analysis disabled. All 10 checks passed:

- One `scan-now` across two roots automatically publishes classifications, exact
  duplicate results, and cleanup recommendations without another analysis call.
- Files and checksums remain unchanged, and no move/delete jobs appear, including
  when the agent polls before any cleanup approval.
- Missing authentication, malformed requests, foreign machines and workspaces,
  repeated receipts, and unsuccessful scans are handled safely.
- A dashboard scan request runs on its owning agent and analyzes new files.
- Background sync stays scan-only; direct scans analyze; pause blocks the flow.
- Explicit quarantine, restore, and permanent deletion execute on the actual
  test files. Checksum checks preserve protected media and remaining copies.

The local browser also exercised the dashboard Scan & Analyze button across two
drives through queued scans, real agent execution, and visible Analysis complete.
Cleanup and duplicate dialogs stayed disabled until approval; cancellation
queued nothing. A browser-approved duplicate moved into quarantine and restored
with its original checksum. Typed `DELETE` enabled the permanent-delete button;
that browser deletion was cancelled. Browser error logs were empty.

## Rollout and limits

This branch requires coordinated backend/dashboard deployment and updated agent
installers. Existing 1.2.3 installers retain their prior behavior until updated.
No installer version bump or release is included here.

The existing analysis limit remains 250,000 catalog files by default. Exceeding
the limit reports failure instead of starting an unbounded catalog rebuild.
Dashboard Scan All creates per-drive jobs; scans that finish far apart can run
separate bounded analyses, while overlapping requests share work.

Windows execution is verified locally. Linux and macOS execution has not been
repeated for this branch. The initial draft commit uses `[skip ci]` to defer
hosted regression jobs. Before merging, push a commit without that instruction
and let the required hosted checks run; marking this draft ready alone does not
start them under the existing workflow configuration.
