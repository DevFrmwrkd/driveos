import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { classifyFile } from "@driveos/shared";

export interface KeepCopyProof {
  fileId: string;
  keepFileId: string;
  keepPath: string;
  keepMachineId: string;
  fullHash: string;
  sizeBytes: number;
}

export function isRegenerablePath(filename: string | undefined): boolean {
  return Boolean(filename && ["CACHE", "RENDER_PREVIEW", "PROXY"].includes(classifyFile(filename, path.basename(filename))));
}

async function inspect(filename: string) {
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`A verified keep copy must be a regular local file: ${filename}`);
  const realPath = fs.realpathSync.native(filename);
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  const after = fs.lstatSync(filename);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || realPath !== fs.realpathSync.native(filename)) {
    throw new Error(`File changed while verifying its keep copy: ${filename}`);
  }
  return { stats: after, realPath, hash: hash.digest("hex") };
}

/** A catalog entry does not prove that a second physical copy still exists.
 * Re-read both files immediately before relocating/deleting a non-generated
 * candidate. Remote-machine copies cannot be verified by this local agent. */
export async function verifyKeepCopy(candidate: {
  fileId: string;
  path: string;
  sizeBytes: number;
  fullHash?: string;
}, proof: KeepCopyProof | undefined, machineId: string | undefined): Promise<() => void> {
  if (!proof || proof.fileId !== candidate.fileId || !proof.keepFileId || proof.keepFileId === candidate.fileId ||
      !machineId || proof.keepMachineId !== machineId || !path.isAbsolute(proof.keepPath) ||
      !/^[a-f0-9]{64}$/i.test(proof.fullHash) || proof.fullHash !== candidate.fullHash ||
      proof.sizeBytes !== candidate.sizeBytes) {
    throw new Error("A current, separate keep-copy proof on this machine is required. Refresh the scan and request cleanup again.");
  }
  const current = await inspect(candidate.path);
  const keep = await inspect(proof.keepPath);
  const samePath = process.platform === "win32"
    ? current.realPath.toLowerCase() === keep.realPath.toLowerCase()
    : current.realPath === keep.realPath;
  if (samePath || (current.stats.dev === keep.stats.dev && current.stats.ino === keep.stats.ino))
    throw new Error("The keep copy must have a separate path and physical file identity.");
  if (current.stats.size !== proof.sizeBytes || keep.stats.size !== proof.sizeBytes ||
      current.hash !== proof.fullHash || keep.hash !== proof.fullHash)
    throw new Error("The candidate or keep-copy content changed. Both copies must match the approved SHA-256 checksum.");
  // A long keep hash must not validate an earlier candidate version which was
  // changed while the other file was being read.
  const stillCurrent = () => {
    for (const [filename, verified] of [[candidate.path, current], [proof.keepPath, keep]] as const) {
      const after = fs.lstatSync(filename);
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== verified.stats.dev || after.ino !== verified.stats.ino ||
          after.size !== verified.stats.size || after.mtimeMs !== verified.stats.mtimeMs || after.ctimeMs !== verified.stats.ctimeMs ||
          fs.realpathSync.native(filename) !== verified.realPath)
        throw new Error("The candidate or keep copy changed after checksum verification. Preserve both copies and scan again.");
    }
  };
  stillCurrent();
  return stillCurrent;
}
