import { classifyFile } from "../packages/shared/src/index";

export interface KeepCopyProof {
  fileId: string;
  keepFileId: string;
  keepPath: string;
  keepMachineId: string;
  fullHash: string;
  sizeBytes: number;
}

export const KEEP_COPY_PROTOCOL = 1;
export const KEEP_COPY_REVIEW = "missing_keep_copy_proof_requires_review";

// Treat case and separator aliases conservatively. The agent also checks real
// paths and filesystem identities before it touches either physical copy.
export function cleanupPathIdentity(value: string) {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").toLowerCase().split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}

export function requiresKeepCopy(file: { path?: string; originalPath?: string; name?: string }) {
  const path = file.originalPath ?? file.path;
  if (!path) return true;
  return !["CACHE", "RENDER_PREVIEW", "PROXY"].includes(classifyFile(path, file.name ?? path.replace(/\\/g, "/").split("/").pop() ?? ""));
}

export function validKeepCopyProof(proof: any, file: { _id?: unknown; fileId?: string; path?: string; originalPath?: string; sizeBytes: number; fullHash?: string }, machineId: string): proof is KeepCopyProof {
  const fileId = String(file._id ?? file.fileId ?? "");
  const originalPath = file.originalPath ?? file.path ?? "";
  return Boolean(proof && fileId && originalPath && proof.fileId === fileId &&
    typeof proof.keepFileId === "string" && proof.keepFileId && proof.keepFileId !== fileId &&
    typeof proof.keepPath === "string" && proof.keepPath &&
    cleanupPathIdentity(proof.keepPath) !== cleanupPathIdentity(originalPath) &&
    proof.keepMachineId === machineId && typeof proof.fullHash === "string" && /^[a-f0-9]{64}$/i.test(proof.fullHash) &&
    (!file.fullHash || proof.fullHash === file.fullHash) && proof.sizeBytes === file.sizeBytes);
}

export function keepCopyReservedIds(job: any): string[] {
  const proofs = [...(Array.isArray(job.result?.keepCopyProofs) ? job.result.keepCopyProofs : []),
    ...(Array.isArray(job.result?.purgeItems) ? job.result.purgeItems.map((item: any) => item.keepCopyProof) : [])];
  return proofs.flatMap(proof => typeof proof?.keepFileId === "string" ? [proof.keepFileId] : []);
}

export function purgeItemMetadata(item: any) {
  const needed = item.requiresKeepCopy === true || requiresKeepCopy(item);
  return {
    quarantineItemId: String(item._id), quarantinePath: item.quarantinePath,
    fileId: item.fileId, originalPath: item.originalPath, sizeBytes: item.sizeBytes,
    requiresKeepCopy: needed,
    ...(item.keepCopyProof ? { keepCopyProof: item.keepCopyProof, fullHash: item.keepCopyProof.fullHash } : {}),
  };
}
