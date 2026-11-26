// A duplicate cluster becomes "resolved" in two different ways: a user marks it
// as intentional redundancy, or cleanup leaves fewer than two live copies. Only
// the automatic case may be reopened when the copies come back (a completed
// restore or a later analysis). Explicit user decisions are never reopened.
export const CLEANUP_RESOLUTION = "cleanup";
export const USER_RESOLUTION = "user";

interface ClusterResolutionState {
  status: string;
  resolution?: string;
  fileCount: number;
}

// Rows written before `resolution` existed carry no marker. The Duplicate
// Center only offers "Intentional" on listed clusters, which have two or more
// copies, so a legacy resolved cluster with fewer copies was resolved by cleanup.
export function resolvedByCleanup(cluster: ClusterResolutionState): boolean {
  if (cluster.status !== "resolved") return false;
  if (cluster.resolution !== undefined) return cluster.resolution === CLEANUP_RESOLUTION;
  return cluster.fileCount < 2;
}

// Cleanup can only auto-resolve a cluster that is still awaiting a decision.
export function cleanupMayResolve(status: string): boolean {
  return status === "open" || status === "queued";
}

// A legacy ignore/intentional decision is recognised only by its copy count.
// Cleanup must record it before removing copies, or a later restore would
// mistake the shrunken cluster for one that cleanup resolved and reopen it.
export function unmarkedUserDecision(cluster: ClusterResolutionState): boolean {
  return cluster.resolution === undefined && !cleanupMayResolve(cluster.status) && !resolvedByCleanup(cluster);
}
