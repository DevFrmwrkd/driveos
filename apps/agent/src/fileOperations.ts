import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { classifyFile } from "@driveos/shared";

export const QUARANTINE_FOLDER_NAME = ".driveos-quarantine";
const PROTECTED = new Set(["RAW", "EXPORT_FINAL", "PROJECT_FILE", "ADMIN", "ARCHIVE_MANIFEST"]);

export interface QuarantineConfig {
  quarantineRoot: string;
  quarantineOnSourceVolume?: boolean;
}

export function isProtectedSourceFile(file: { path: string; classification?: string; isRaw?: boolean; isFinal?: boolean; isProjectFile?: boolean }): boolean {
  const currentClass = classifyFile(file.path, path.basename(file.path));
  const normalized = file.path.replace(/\\/g, "/").toUpperCase();
  return PROTECTED.has(currentClass) || PROTECTED.has(file.classification || "") ||
    Boolean(file.isRaw || file.isFinal || file.isProjectFile) ||
    /\/(02_RAW|RAW|08_DELIVERY|DELIVERY)\//.test(normalized) ||
    /\/(07_EXPORTS|EXPORTS)\/FINAL\//.test(normalized);
}

export function preserveOriginalPath(originalPath: string): string {
  const resolved = path.resolve(originalPath);
  const parsed = path.parse(resolved);
  return path.join(parsed.root.replace(/[:/\\]+/g, "_"), path.relative(parsed.root, resolved));
}

export function volumeRootForPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (process.platform === "darwin") {
    const external = resolved.match(/^(\/Volumes\/[^/]+)/);
    if (external) return external[1];
  }
  return path.parse(resolved).root;
}

export function quarantineDestination(filePath: string, config: QuarantineConfig, jobId: string, date: string): string {
  const root = config.quarantineOnSourceVolume !== false
    ? path.join(volumeRootForPath(filePath), QUARANTINE_FOLDER_NAME)
    : path.resolve(config.quarantineRoot);
  // Keeping the source hierarchy prevents identical camera/cache filenames in
  // different folders from ever sharing a quarantine destination.
  return path.join(root, date, jobId, preserveOriginalPath(filePath));
}

function checksum(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = fs.openSync(filePath, "r");
  try {
    let count: number;
    while ((count = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally {
    fs.closeSync(handle);
  }
}

/** Move without replacing an existing file, including when restoring originals. */
export function moveFileSafely(source: string, destination: string): void {
  const original = fs.lstatSync(source);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error(`Not a regular source file: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    // A hard link is a constant-time same-volume move with exclusive destination
    // creation. Unlike rename(), it cannot silently replace another file.
    fs.linkSync(source, destination);
  } catch (error: any) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EACCES"].includes(error.code)) throw error;
    // External disks without hard-link support and cross-volume restores use an
    // exclusive copy. Verify actual content before removing the original.
    let created = false;
    try {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      created = true;
      const current = fs.statSync(source);
      if (current.size !== original.size || current.mtimeMs !== original.mtimeMs ||
          fs.statSync(destination).size !== original.size || checksum(source) !== checksum(destination)) {
        throw new Error(`Source changed or quarantine copy verification failed: ${source}`);
      }
    } catch (copyError) {
      if (created) fs.unlinkSync(destination);
      throw copyError;
    }
  }
  // A failed unlink leaves both copies available instead of destroying data.
  fs.unlinkSync(source);
}
