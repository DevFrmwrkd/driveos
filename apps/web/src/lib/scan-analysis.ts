export type AnalysisState = {
  status: "idle" | "queued" | "running" | "completed" | "failed" | "stale";
  catalogCurrent: boolean;
  lastRunAt: number | null;
  completedAt: number | null;
  error: string | null;
  maxFiles: number;
};

type ScanJob = {
  action?: string; status?: string; machineId?: string;
  createdAt?: number; updatedAt?: number; completedAt?: number;
  result?: { analyzeAfterScan?: boolean; driveId?: string; error?: string };
};
type ScanSession = {
  machineId: string; driveId?: string; startedAt: number; completedAt?: number;
  status: string; errorsCount: number;
};
type StatusMessage = { title: string; detail: string; kind: "accent" | "ok" | "warn" | "risk" };

export function scanRequestFeedback(queued: number): { message: string; kind: "accent" | "warn" } {
  return queued > 0 ? {
    message: `Scan & Analyze queued for ${queued} drive(s). Waiting for the owning agents; analysis follows successful scans.`,
    kind: "accent",
  } : {
    message: "No new scans were queued. Existing scan requests may still be waiting for their agents.",
    kind: "warn",
  };
}

function failedScanRecovered(job: ScanJob, analysis: AnalysisState | undefined, sessions: ScanSession[]): boolean {
  if (analysis?.status !== "completed" || !analysis.catalogCurrent || analysis.lastRunAt === null ||
      !job.machineId || !job.result?.driveId) return false;
  const analyzedAt = analysis.lastRunAt;
  const failedAt = job.completedAt ?? job.updatedAt ?? job.createdAt;
  if (failedAt === undefined) return false;
  const laterAttempts = sessions.filter(scan =>
    scan.machineId === job.machineId && scan.driveId === job.result?.driveId && scan.startedAt > failedAt);
  const latestStartedAt = Math.max(...laterAttempts.map(scan => scan.startedAt));
  const latestAttempts = laterAttempts.filter(scan => scan.startedAt === latestStartedAt);
  // Use the latest attempt, including simultaneous attempts, so a later partial
  // scan cannot be hidden by an earlier successful desktop scan.
  return latestAttempts.length > 0 && latestAttempts.every(scan =>
    scan.status === "completed" && scan.errorsCount === 0 && scan.completedAt !== undefined &&
    scan.completedAt >= scan.startedAt && analyzedAt >= scan.completedAt);
}

export function scanAnalysisMessage(analysis: AnalysisState | undefined, jobs: ScanJob[], sessions: ScanSession[] = []): StatusMessage | null {
  const requests = jobs.filter(job => job.action === "scan" && job.result?.analyzeAfterScan === true);
  const latestRequestAt = Math.max(...requests.map(job => job.createdAt || 0));
  const latestRequest = requests.filter(job => (job.createdAt || 0) === latestRequestAt);
  const scans = latestRequest.filter(job => ["approved", "queued", "running"].includes(job.status || ""));
  const failed = latestRequest.find(job => job.status === "failed" && !failedScanRecovered(job, analysis, sessions));
  if (failed) return {
    title: "Scan & Analyze failed",
    detail: (failed.result?.error || "A drive scan did not finish. Check its owning agent, reconnect the drive, and try Scan & Analyze again.") +
      (scans.length ? ` ${scans.length} other drive scan(s) are waiting or running.` : ""),
    kind: "risk",
  };
  if (scans.length > 0) return {
    title: scans.some(job => job.status === "running") ? "Scanning files" : "Scan & Analyze queued",
    detail: `${scans.length} drive scan(s) waiting or running. Keep the owning agents and drives available. Analysis follows successful scans.`,
    kind: "accent",
  };
  if (!analysis || analysis.status === "idle") return null;
  if (analysis.status === "running") return {
    title: "Analysis running", detail: "DriveOS is finding duplicates and cleanup candidates in the scanned catalog. File changes still need your approval.", kind: "accent",
  };
  if (analysis.status === "queued") return {
    title: "Analysis queued", detail: "Waiting to analyze the scanned catalog. Cleanup requires your approval after results are ready.", kind: "accent",
  };
  if (analysis.status === "failed") return {
    title: "Analysis failed", detail: analysis.error || "Analysis could not finish. Re-run analysis to retry the current catalog.", kind: "risk",
  };
  if (analysis.status === "completed" && analysis.catalogCurrent) return {
    title: "Analysis complete", detail: "Review Duplicate Center and Cleanup for the latest results. Files stay in place until you approve an operation.", kind: "ok",
  };
  return {
    title: "Analysis needs updating", detail: "The catalog has changed. Use Scan & Analyze to refresh files and results, or Re-run analysis to check the current catalog.", kind: "warn",
  };
}
