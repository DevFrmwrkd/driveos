interface CatalogAnalysisState {
  dirtyCount?: number;
  catalogGeneration?: number;
  analyzedGeneration?: number;
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
