import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkManifestFiles } from "./manifestFiles.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-manifest-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("archive inventory includes small, temporary, and hidden project files", async t => {
  const root = fixture(t);
  for (const filename of ["TMP/camera.mov", "TEMPORARY/edit.prproj", ".hidden/license.txt", "09_ARCHIVE_MANIFEST/archive_manifest.json"]) {
    fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    fs.writeFileSync(path.join(root, filename), "project content");
  }
  const seen: string[] = [];
  await walkManifestFiles(root, async filename => { seen.push(path.relative(root, filename).replace(/\\/g, "/")); });
  assert.deepEqual(seen.sort(), [".hidden/license.txt", "TEMPORARY/edit.prproj", "TMP/camera.mov"]);
});

test("an unreadable project entry fails the inventory instead of certifying a partial manifest", async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "camera.mov"), "project content");
  t.mock.method(fs, "lstatSync", () => { throw Object.assign(new Error("Unreadable camera.mov"), { code: "EACCES" }); });
  await assert.rejects(walkManifestFiles(root, async () => {}), /Unreadable camera.mov/);
});
