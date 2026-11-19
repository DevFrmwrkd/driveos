import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

function compile(source) {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}
const policyUrl = `data:text/javascript;base64,${Buffer.from(compile(fs.readFileSync(new URL("../convex/demoSeedPolicy.ts", import.meta.url), "utf8"))).toString("base64")}`;
const { requireLocalDemoSeed } = await import(policyUrl);
const source = fs.readFileSync(new URL("../convex/seed.ts", import.meta.url), "utf8")
  .replace('import { internalMutation } from "./_generated/server";', `import { internalMutationGeneric as internalMutation } from ${JSON.stringify(import.meta.resolve("convex/server"))};`)
  .replace('"./demoSeedPolicy"', JSON.stringify(policyUrl));
const { seed } = await import(`data:text/javascript;base64,${Buffer.from(compile(source)).toString("base64")}`);

test("demo reset is internal rather than an anonymous public API", () => {
  assert.equal(seed.isInternal, true);
  assert.notEqual(seed.isPublic, true);
});

test("demo reset refuses hosted, missing, and non-opted-in environments", () => {
  for (const environment of [
    {},
    { CONVEX_SITE_URL: "http://127.0.0.1:3211" },
    { CONVEX_SITE_URL: "https://example.convex.site", DRIVEOS_ENABLE_DEMO_SEED: "1" },
    { CONVEX_SITE_URL: "https://production.example.com", DRIVEOS_ENABLE_DEMO_SEED: "1" },
    { CONVEX_SITE_URL: "http://127.0.0.1.example.com", DRIVEOS_ENABLE_DEMO_SEED: "1" },
  ]) assert.throws(() => requireLocalDemoSeed(environment), /disabled/);
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.doesNotThrow(() => requireLocalDemoSeed({ CONVEX_SITE_URL: `http://${hostname}:3211`, DRIVEOS_ENABLE_DEMO_SEED: "1" }));
  }
});

test("disabled demo reset rejects before accessing any application data", async () => {
  const previous = process.env.DRIVEOS_ENABLE_DEMO_SEED;
  delete process.env.DRIVEOS_ENABLE_DEMO_SEED;
  try {
    await assert.rejects(seed._handler({ db: new Proxy({}, { get() { throw new Error("Database must not be accessed"); } }) }, {}), /Demo seeding is disabled/);
  } finally {
    if (previous === undefined) delete process.env.DRIVEOS_ENABLE_DEMO_SEED;
    else process.env.DRIVEOS_ENABLE_DEMO_SEED = previous;
  }
});
