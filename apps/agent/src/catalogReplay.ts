import type { CatalogReceipt, CatalogScope } from "./watchQueue.js";

interface CachedObservation {
  uploadedFp?: string;
  observationInvalidated?: boolean;
  catalogReceipt?: CatalogReceipt;
}

// A partially replayed drive already hasCatalog on the next scan. An explicit
// marker must survive that transition so the legacy no-FP bridge cannot adopt
// old hashes for rows which this drive has never actually acknowledged.
export function requireCatalogReplay(entry: CachedObservation, scope: CatalogScope, newDrive = false): boolean {
  const receipt = entry.catalogReceipt;
  const foreignReceipt = receipt && ((receipt.driveId !== undefined && receipt.driveId !== scope.driveId) ||
    (receipt.machineId !== undefined && receipt.machineId !== scope.machineId));
  if (!newDrive && !foreignReceipt) return false;
  const changed = entry.uploadedFp !== undefined || entry.observationInvalidated !== true;
  delete entry.uploadedFp;
  entry.observationInvalidated = true;
  return changed;
}
