"use client";

import React from "react";
import { Icon } from "@/components/icons";

// Public GitHub Release assets produced by .github/workflows/build-desktop.yml.
// Stable, version-independent names (set via electron-builder artifactName) so
// these "latest" URLs never break across releases.
const REPO = "https://github.com/DevFrmwrkd/driveos";
export const DOWNLOADS = {
  mac: `${REPO}/releases/latest/download/DriveOS-Agent-mac.dmg`,
  win: `${REPO}/releases/latest/download/DriveOS-Agent-win.exe`,
  releases: `${REPO}/releases/latest`,
};

function detectOS(): "mac" | "win" | "other" {
  if (typeof navigator === "undefined") return "other";
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "win";
  return "other";
}

const STEPS = [
  "Install and open the DriveOS Agent on your editing machine.",
  "In the dashboard, go to Settings → Devices and create a connect token.",
  "Paste the token into the app to link this machine to your workspace.",
  "Pick the drives to track — DriveOS indexes file metadata, never your footage.",
];

export function DownloadScreen({ embedded = false }: { embedded?: boolean }) {
  const os = detectOS();

  const card = (
    <div
      className="card fade-up"
      style={{ width: "100%", maxWidth: 560, overflow: "hidden", margin: "0 auto" }}
    >
      <div style={{ padding: "30px 28px 20px", textAlign: "center", borderBottom: "1px solid var(--line)" }}>
        <div
          style={{
            width: 52, height: 52, borderRadius: 13, margin: "0 auto 14px", display: "grid",
            placeItems: "center", background: "var(--accent)", boxShadow: "0 0 30px var(--accent-glow)",
          }}
        >
          <Icon name="hdd" size={24} style={{ color: "#fff" }} stroke={2.4} />
        </div>
        <h1 style={{ fontSize: 21, fontWeight: 700, color: "var(--tx-hi)" }}>Download the DriveOS app</h1>
        <div className="muted" style={{ fontSize: 13, marginTop: 5, maxWidth: 380, marginInline: "auto" }}>
          The local agent scans your drives and syncs a live storage map to the dashboard. Metadata only — your media never leaves your machine.
        </div>
      </div>

      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <a
            className="btn primary lg"
            href={DOWNLOADS.mac}
            style={{ flex: "1 1 200px", justifyContent: "center", textDecoration: "none", position: "relative" }}
          >
            <Icon name="download" size={16} style={{ marginRight: 8 }} />
            macOS (.dmg)
            {os === "mac" && <span className="nav-badge" style={{ marginLeft: 8 }}>Your OS</span>}
          </a>
          <a
            className="btn primary lg"
            href={DOWNLOADS.win}
            style={{ flex: "1 1 200px", justifyContent: "center", textDecoration: "none" }}
          >
            <Icon name="download" size={16} style={{ marginRight: 8 }} />
            Windows (.exe)
            {os === "win" && <span className="nav-badge" style={{ marginLeft: 8 }}>Your OS</span>}
          </a>
        </div>
        <a
          href={DOWNLOADS.releases}
          target="_blank"
          rel="noreferrer"
          className="dim"
          style={{ fontSize: 11.5, textAlign: "center", textDecoration: "none" }}
        >
          All versions & release notes →
        </a>

        <div style={{ marginTop: 8, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tx-mut)", marginBottom: 10 }}>
            After installing
          </div>
          <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 9 }}>
            {STEPS.map((s, i) => (
              <li key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span
                  style={{
                    flexShrink: 0, width: 20, height: 20, borderRadius: 6, display: "grid", placeItems: "center",
                    background: "var(--accent-soft)", color: "var(--accent-hi)", fontSize: 11, fontWeight: 700,
                  }}
                >
                  {i + 1}
                </span>
                <span style={{ fontSize: 12.5, color: "var(--tx-mut)", lineHeight: 1.5 }}>{s}</span>
              </li>
            ))}
          </ol>
        </div>

        {!embedded && (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.location.hash = "";
            }}
            className="dim"
            style={{ fontSize: 12, textAlign: "center", marginTop: 6, textDecoration: "none" }}
          >
            ← Back to sign in
          </a>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return <div className="page-inner" style={{ paddingTop: 24 }}>{card}</div>;
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", padding: 24 }}>
      {card}
    </div>
  );
}
