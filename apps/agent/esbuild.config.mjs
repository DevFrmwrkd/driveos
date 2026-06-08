// Bundle the agent + all its deps (incl. @driveos/shared) into one self-contained
// CommonJS file the desktop app can run with no node_modules. Output: dist/agent-bundle.cjs
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/agent-bundle.cjs",
  // fsevents is an optional native dep of chokidar (macOS); mark external so the
  // bundle works cross-platform and falls back to polling where it's absent.
  external: ["fsevents"],
  banner: { js: "/* DriveOS agent bundle — generated, do not edit */" },
  logLevel: "info",
});
