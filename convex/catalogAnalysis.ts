interface CatalogAnalysisState {
  dirtyCount?: number;
  catalogGeneration?: number;
  analyzedGeneration?: number;
  scheduled?: boolean;
  analysisRunId?: number;
  analysisFunctionId?: string;
  scanAnalysisRequestVersion?: number;
  scanAnalysisResolvedVersion?: number;
}

export const ANALYSIS_DEBOUNCE_MS = 5 * 60 * 1000;
export const ANALYSIS_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function hasRequestedScanAnalysis(state: CatalogAnalysisState | null | undefined): boolean {
  return (state?.scanAnalysisRequestVersion ?? 0) > (state?.scanAnalysisResolvedVersion ?? 0);
}

export function analysisFollowUpDelay(lastRunAt: number, now: number): number {
  return Math.max(ANALYSIS_DEBOUNCE_MS, lastRunAt + ANALYSIS_MIN_INTERVAL_MS - now);
}

export function ownsAnalysisRun(state: CatalogAnalysisState | null | undefined, runId: number | undefined): boolean {
  return Boolean(state?.scheduled && (runId === undefined
    ? state.analysisRunId === undefined && !state.analysisFunctionId
    : state.analysisRunId === runId));
}

// Missing generations describe the legacy catalog and its existing analysis.
export function catalogGeneration(state: CatalogAnalysisState | null | undefined): number {
  return state?.catalogGeneration ?? 0;
}

export function catalogAnalysisIsCurrent(state: CatalogAnalysisState | null | undefined): boolean {
  return catalogGeneration(state) <= (state?.analyzedGeneration ?? 0);
}

export async function analysisStateForTenant(ctx: any, tenantId: string) {
  return await ctx.db.query("analysisState").withIndex("by_tenant", (q: any) => q.eq("tenantId", tenantId)).first();
}

// Deleting a file invalidates all cached aggregate claims in one write. Public
// readers do not fan out over every recommendation/cluster to discover ghosts.
export async function cachedAnalysisIsCurrent(ctx: any, tenantId: string): Promise<boolean> {
  return catalogAnalysisIsCurrent(await analysisStateForTenant(ctx, tenantId));
}

export function canPublishAnalysis(state: CatalogAnalysisState | null | undefined, capturedGeneration: number | undefined): boolean {
  // An older in-flight action has no generation receipt. It must not clear an
  // invalidation created by a newer deletion.
  return capturedGeneration !== undefined && catalogGeneration(state) === capturedGeneration;
}
