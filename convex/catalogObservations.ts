export interface CatalogFingerprint {
  path: string;
  sizeBytes: number;
  modifiedAtFile: number;
  quickHash?: string;
  fullHash?: string;
}

export interface CatalogReceipt extends CatalogFingerprint {
  fileId: string;
  catalogVersion: number;
}

export const MAX_CATALOG_RECEIPTS = 100;

function absoluteParts(value: string) {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  let path = value.replace(/\\/g, "/");
  let root: string;
  let remainder: string;
  if (/^[a-z]:\//i.test(path)) {
    path = path.toLowerCase(); root = path.slice(0, 2); remainder = path.slice(3);
  } else if (path.startsWith("//")) {
    const [server, share, ...rest] = path.slice(2).toLowerCase().split("/");
    if (!server || !share || [server, share].some(part => part === "." || part === "..")) return null;
    root = `//${server}/${share}`; remainder = rest.join("/");
  } else if (path.startsWith("/")) {
    root = "/"; remainder = path.slice(1);
  } else return null;
  const parts: string[] = [];
  for (const part of remainder.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return { root, parts };
}

export function catalogPathWithin(candidate: string, directory: string, allowEqual = false) {
  const file = absoluteParts(candidate), root = absoluteParts(directory);
  return Boolean(file && root && file.root === root.root &&
    (allowEqual ? file.parts.length >= root.parts.length : file.parts.length > root.parts.length) &&
    root.parts.every((part, index) => file.parts[index] === part));
}

export function catalogFingerprintMatches(file: any, expected: CatalogFingerprint) {
  return file.path === expected.path && file.sizeBytes === expected.sizeBytes && file.modifiedAtFile === expected.modifiedAtFile &&
    file.quickHash === expected.quickHash && file.fullHash === expected.fullHash;
}

// Legacy quick scans may omit a full hash retained by the server. Bootstrap
// from a matching known hash, then send the complete server fingerprint in the
// deletion CAS. Unknown hashes never become a wildcard in reportMissingFiles.
export function catalogKnownFingerprintMatches(file: any, expected: CatalogFingerprint) {
  const known = [expected.quickHash, expected.fullHash].some(hash => typeof hash === "string" && hash.length > 0);
  return known && file.path === expected.path && file.sizeBytes === expected.sizeBytes && file.modifiedAtFile === expected.modifiedAtFile &&
    (expected.quickHash === undefined || file.quickHash === expected.quickHash) &&
    (expected.fullHash === undefined || file.fullHash === expected.fullHash);
}

export function catalogReceipt(file: any): CatalogReceipt {
  return { path: file.path, fileId: String(file._id), catalogVersion: file.observationRevision ?? 0,
    sizeBytes: file.sizeBytes, modifiedAtFile: file.modifiedAtFile,
    ...(file.quickHash !== undefined ? { quickHash: file.quickHash } : {}),
    ...(file.fullHash !== undefined ? { fullHash: file.fullHash } : {}) };
}
