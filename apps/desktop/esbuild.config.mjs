// Bundle the Electron main + preload into self-contained CommonJS files with all
// runtime deps (e.g. auto-launch) inlined. This means electron-builder ships ONLY
// dist/ + renderer/ + package.json and never has to collect node_modules — which
// is what breaks under npm workspaces (hoisted deps aren't found in the app dir).
import { build } from "esbuild";
import { copyFileSync } from "node:fs";

// The renderer logo is generated/ignored locally, so fresh CI checkouts need
// the committed brand icon copied into the packaged renderer assets.
copyFileSync(new URL("./build/icon.png", import.meta.url), new URL("./renderer/logo.png", import.meta.url));

const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  // `electron` is provided by the runtime, never bundle it.
  external: ["electron"],
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js" });
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js" });
