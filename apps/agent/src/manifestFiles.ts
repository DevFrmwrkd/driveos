import fs from "node:fs";
import path from "node:path";

/** Archive inventories fail closed on unreadable entries; scanner exclusions do not apply. */
export async function walkManifestFiles(root: string, visit: (filePath: string, stats: fs.Stats) => Promise<void>): Promise<void> {
  async function walk(directory: string) {
    for (const name of fs.readdirSync(directory)) {
      if (directory === root && name.toUpperCase() === "09_ARCHIVE_MANIFEST") continue;
      const filename = path.join(directory, name);
      const stats = fs.lstatSync(filename);
      if (stats.isSymbolicLink()) throw new Error(`Archive inventory requires a regular local file instead of a symbolic link: ${filename}`);
      if (stats.isDirectory()) await walk(filename);
      else if (stats.isFile()) await visit(filename, stats);
      else throw new Error(`Unsupported archive inventory entry: ${filename}`);
    }
  }
  await walk(root);
}
