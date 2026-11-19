import test from "node:test";
import assert from "node:assert/strict";
import { requireCatalogReplay } from "./catalogReplay.js";
import type { CatalogReceipt } from "./watchQueue.js";

const scope = { driveId: "new-drive", machineId: "machine-a" };
const cache = () => ({ sizeBytes: 2048, modifiedAt: 1234, quickHash: "quick", uploadedFp: "2048|1234|quick||CACHE|green",
  observationInvalidated: undefined as boolean | undefined, catalogReceipt: undefined as CatalogReceipt | undefined });

test("a partial new-drive replay keeps every unacknowledged file out of the legacy baseline bridge", () => {
  const entries = [cache(), cache(), cache()];
  // Include a legacy hash-only row as well as previously uploaded stamps.
  delete (entries[2] as { uploadedFp?: string }).uploadedFp;
  for (const entry of entries) requireCatalogReplay(entry, scope, true);
  assert.ok(entries.every(entry => entry.observationInvalidated === true && entry.uploadedFp === undefined));
  // First batch succeeds, then a budget/network error interrupts the cycle.
  // Real stampUploaded clears the marker only after an accepted backend ACK.
  entries[0] = { ...entries[0], uploadedFp: "acknowledged-by-new-drive", observationInvalidated: undefined };
  const persisted = JSON.parse(JSON.stringify(entries)) as ReturnType<typeof cache>[];
  // On restart hasCatalog is true, so registration no longer reports isNew.
  // The per-file helper must retain the earlier replay marker for the rest.
  for (const entry of persisted) requireCatalogReplay(entry, scope);
  assert.equal(persisted[0].observationInvalidated, undefined);
  assert.ok(persisted.slice(1).every(entry => entry.observationInvalidated === true && entry.uploadedFp === undefined));
  // buildFileMetadata spreads prior state while refreshing the quick hash.
  const rebuilt = { ...persisted[1], quickHash: "quick", sizeBytes: 2048, modifiedAt: 1234 };
  assert.equal(rebuilt.observationInvalidated, true);
});

test("a scoped acknowledgement from another drive or machine cannot authorize a delta skip", () => {
  for (const foreign of [{ driveId: "old-drive", machineId: scope.machineId }, { driveId: scope.driveId, machineId: "machine-b" }]) {
    const entry = cache();
    entry.catalogReceipt = { path: "/media/clip", fileId: "old-file", catalogVersion: 42,
      sizeBytes: entry.sizeBytes, modifiedAtFile: entry.modifiedAt, quickHash: entry.quickHash, ...foreign };
    assert.equal(requireCatalogReplay(entry, scope), true);
    assert.equal(entry.uploadedFp, undefined);
    assert.equal(entry.observationInvalidated, true);
  }
});

test("matching scoped acknowledgements and legacy unscoped baselines remain unchanged", () => {
  for (const identity of [scope, {}]) {
    const entry = cache();
    entry.catalogReceipt = { path: "/media/clip", fileId: "file-a", catalogVersion: 1,
      sizeBytes: entry.sizeBytes, modifiedAtFile: entry.modifiedAt, quickHash: entry.quickHash, ...identity };
    const before = structuredClone(entry);
    assert.equal(requireCatalogReplay(entry, scope), false);
    assert.deepEqual(entry, before);
  }
  const legacy = cache();
  delete (legacy as { uploadedFp?: string }).uploadedFp;
  assert.equal(requireCatalogReplay(legacy, scope), false);
  assert.equal(legacy.observationInvalidated, undefined);
});
