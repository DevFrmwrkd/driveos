// Generate all app icons from a single source logo.
//   Source:  assets/logo.png   (square, ideally 1024x1024, transparent bg)
//   Outputs:
//     apps/web/src/app/icon.png            (Next.js auto favicon / tab icon)
//     apps/web/src/app/apple-icon.png      (iOS/Safari)
//     apps/desktop/build/icon.png          (Linux + electron-builder source)
//     apps/desktop/build/icon.ico          (Windows app/installer icon)
//     apps/desktop/build/icon.icns         (macOS app icon)
//
// Run:  node scripts/applyLogo.mjs
import fs from "fs";
import path from "path";
import sharp from "sharp";
import png2icons from "png2icons";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "assets", "logo.png");

if (!fs.existsSync(SRC)) {
  console.error(`[applyLogo] Missing source logo at ${SRC}. Save your logo there first.`);
  process.exit(1);
}

const webDir = path.join(ROOT, "apps", "web", "src", "app");
const deskBuild = path.join(ROOT, "apps", "desktop", "build");
fs.mkdirSync(deskBuild, { recursive: true });

async function png(size, out) {
  await sharp(SRC).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(out);
  console.log("  wrote", path.relative(ROOT, out));
}

// Web: Next.js picks up icon.png / apple-icon.png in app/ automatically.
await png(512, path.join(webDir, "icon.png"));
await png(180, path.join(webDir, "apple-icon.png"));

// Desktop renderer header logo.
await png(128, path.join(ROOT, "apps", "desktop", "renderer", "logo.png"));

// Desktop: 1024 master PNG, then .ico (Win) and .icns (Mac).
const master = path.join(deskBuild, "icon.png");
await png(1024, master);
const buf = fs.readFileSync(master);
fs.writeFileSync(path.join(deskBuild, "icon.ico"), png2icons.createICO(buf, png2icons.BILINEAR, 0, false));
console.log("  wrote", path.relative(ROOT, path.join(deskBuild, "icon.ico")));
fs.writeFileSync(path.join(deskBuild, "icon.icns"), png2icons.createICNS(buf, png2icons.BILINEAR, 0));
console.log("  wrote", path.relative(ROOT, path.join(deskBuild, "icon.icns")));

console.log("[applyLogo] Done.");
