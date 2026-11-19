import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProtectedSourceFile, moveFileSafely, quarantineDestination } from "./fileOperations.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-file-safety-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("a batch preserves both same-named originals in separate quarantine paths", (t) => {
  const root = fixture(t);
  const sources = [path.join(root, "A", "preview.mov"), path.join(root, "B", "preview.mov")];
  const contents = ["FIRST ORIGINAL", "SECOND ORIGINAL"];
  const config = { quarantineRoot: path.join(root, "quarantine"), quarantineOnSourceVolume: false };
  const destinations = sources.map(source => quarantineDestination(source, config, "job-1", "2026-11-19"));
  // The default per-volume layout must also retain distinct source hierarchies.
  assert.notEqual(quarantineDestination(sources[0], { ...config, quarantineOnSourceVolume: true }, "job-1", "2026-11-19"), quarantineDestination(sources[1], { ...config, quarantineOnSourceVolume: true }, "job-1", "2026-11-19"));
  for (let i = 0; i < sources.length; i++) {
    fs.mkdirSync(path.dirname(sources[i]), { recursive: true });
    fs.writeFileSync(sources[i], contents[i]);
    moveFileSafely(sources[i], destinations[i]);
    assert.equal(fs.existsSync(sources[i]), false);
    assert.equal(fs.readFileSync(destinations[i], "utf8"), contents[i]);
  }
});

test("existing quarantine or restore destinations are never overwritten", (t) => {
  const root = fixture(t);
  const source = path.join(root, "original.mov");
  const destination = path.join(root, "existing.mov");
  fs.writeFileSync(source, "SOURCE");
  fs.writeFileSync(destination, "KEEP THIS");
  assert.throws(() => moveFileSafely(source, destination), { code: "EEXIST" });
  assert.equal(fs.readFileSync(source, "utf8"), "SOURCE");
  assert.equal(fs.readFileSync(destination, "utf8"), "KEEP THIS");
});

test("cross-volume fallback preserves content and refuses an existing destination", (t) => {
  const root = fixture(t);
  const source = path.join(root, "original.dat");
  const destination = path.join(root, "quarantine.dat");
  fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 73));
  const expected = fs.readFileSync(source);
  t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("cross volume"), { code: "EXDEV" }); });
  moveFileSafely(source, destination);
  assert.deepEqual(fs.readFileSync(destination), expected);
  assert.equal(fs.existsSync(source), false);
  fs.writeFileSync(source, "NEXT FILE");
  assert.throws(() => moveFileSafely(source, destination), { code: "EEXIST" });
  assert.equal(fs.readFileSync(source, "utf8"), "NEXT FILE");
  assert.deepEqual(fs.readFileSync(destination), expected);
});

test("stale catalog classifications cannot unprotect Windows RAW or final files", () => {
  for (const source of [String.raw`E:\Show\02_RAW\take.mov`, String.raw`\\studio\media\08_DELIVERY\master.mp4`, String.raw`E:\Show\07_EXPORTS\FINAL\master.mov`]) {
    assert.equal(isProtectedSourceFile({ path: source, classification: "UNKNOWN" }), true);
  }
  assert.equal(isProtectedSourceFile({ path: "/Show/06_RENDERS_CACHE/preview.dat", classification: "CACHE" }), false);
});

test("a same-size corrupt cross-volume copy never removes the original", (t) => {
  const root = fixture(t);
  const source = path.join(root, "original.dat");
  const destination = path.join(root, "quarantine.dat");
  fs.writeFileSync(source, "ORIGINAL");
  const realCopy = fs.copyFileSync;
  t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("cross volume"), { code: "EXDEV" }); });
  t.mock.method(fs, "copyFileSync", (from: fs.PathLike, to: fs.PathLike, flags?: number) => {
    realCopy(from, to, flags);
    fs.writeFileSync(to, "CORRUPT!");
  });
  assert.throws(() => moveFileSafely(source, destination), /verification failed/);
  assert.equal(fs.readFileSync(source, "utf8"), "ORIGINAL");
  assert.equal(fs.existsSync(destination), false);
});
