/* ============================================================
   DriveOS — Cloud Storage
   ============================================================ */
(function () {
  const h = window.h, cardShell = window.cardShell, getVar = window.getVar;
  const DB = window.DB, C = DB.cloud;

  function CloudScreen({ go, toast }) {
    const p = pct(C.usedTB, C.capTB);
    const cloudProjects = DB.projects.filter((pr) => pr.locations.includes("gdrive"));

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Storage", title: "Cloud Storage", desc: "Google Workspace tracked alongside local drives — quota, sync gaps, duplicates, and per-project cloud coverage.",
        actions: [
          h("button", { key: 1, className: "btn", onClick: () => toast("Scanning cloud…", "refresh", "cloud") }, h(Icon, { name: "refresh", size: 15 }), "Scan Cloud"),
          h("button", { key: 2, className: "btn primary", onClick: () => toast("Matching cloud folders to projects…", "link", "accent") }, h(Icon, { name: "link", size: 15 }), "Match to Projects")] }),

      // account + quota
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: "var(--gap)", marginBottom: "var(--gap)" } },
        h("div", { className: "card card-pad fade-up", style: { display: "flex", gap: 18, alignItems: "center" } },
          h(Donut, { data: [{ value: C.usedTB, color: getVar("var(--cloud)") }, { value: C.capTB - C.usedTB, color: "rgba(255,255,255,0.06)" }], size: 132, thickness: 17 },
            h("div", { className: "stat-num", style: { fontSize: 22, color: "var(--cloud)" } }, p + "%"), h("div", { style: { fontSize: 9.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)" } }, "USED")),
          h("div", { style: { flex: 1 } },
            h("div", { className: "row", style: { gap: 9, marginBottom: 10 } },
              h("div", { style: { width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: "var(--cloud-soft)", color: "var(--cloud)", border: "1px solid var(--cloud-line)" } }, h(Icon, { name: "cloud", size: 17 })),
              h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 14 } }, C.provider), h("div", { className: "mono dim", style: { fontSize: 11 } }, C.account))),
            h("div", { className: "stat-num", style: { fontSize: 26 } }, fmtTB(C.usedTB), h("span", { style: { fontSize: 14, color: "var(--tx-mut)", fontWeight: 600 } }, " / " + C.capTB + " TB")),
            h("div", { style: { marginTop: 8 } }, h(Bar, { value: C.usedTB, max: C.capTB, kind: "cloud", height: 8 })),
            h("div", { className: "muted", style: { fontSize: 11.5, marginTop: 7 } }, fmtTB(C.capTB - C.usedTB) + " free · ", h("span", { style: { color: "var(--cloud)" } }, "Connected · OAuth"))) ),

        // sync recommendations
        cardShell("Sync Recommendations", "sparkle", "var(--accent-hi)", null,
          h("div", { style: { padding: 14, display: "flex", flexDirection: "column", gap: 10 } },
            syncRec("Upload Atlas hero export to cloud", "Final export exists only locally on Ingest RAID — no off-site copy.", "risk", "upload", "Upload 36 GB", toast),
            syncRec("Centralize duplicated cloud stock", "city_timelapse_4k.mp4 stored 3× in cloud project folders.", "warn", "copy", "Recover 48 GB", toast),
            syncRec("Archive delivered Client Launch cloud folder", "Delivered 9 days ago — move from active to cold cloud tier.", "review", "archive", "Free 18 GB", toast)))),

      // comparison KPIs
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "var(--gap)", marginBottom: "var(--gap)" } },
        ckpi("Cloud projects", cloudProjects.length, "folder", "var(--cloud)"),
        ckpi("In cloud, not local", fmtGB(C.inCloudNotLocal.reduce((s, f) => s + f.sizeGB, 0)), "download", "var(--accent-hi)"),
        ckpi("Local, not in cloud", "956 GB", "upload", "var(--warn)"),
        ckpi("Cloud duplicates", "1.1 TB", "copy", "var(--auto)")),

      // local vs cloud comparison columns
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)", marginBottom: "var(--gap)" } },
        compareCard("In Cloud, Missing Locally", "download", "var(--accent-hi)", C.inCloudNotLocal, "These are safe — cloud has the only copy. Pull down if an editor needs them.", "ok", go),
        compareCard("Local, Missing in Cloud", "upload", "var(--warn)", C.localNotCloud, "No off-site backup. Risky for finals and single-copy RAW.", "warn", go, true)),

      // duplicate cloud + large cloud
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)" } },
        cardShell("Duplicate Cloud Files", "copy", "var(--auto)", h("button", { className: "btn sm ghost", onClick: () => go("duplicates") }, "Review"),
          h("div", { style: { padding: "6px 0" } }, C.dupCloud.map((f, i) => h("div", { key: i, className: "spread", style: { padding: "11px 18px", borderBottom: i < C.dupCloud.length - 1 ? "1px solid var(--line-faint)" : "none" } },
            h("div", { className: "row", style: { gap: 9, minWidth: 0 } }, h(Icon, { name: "cloud", size: 14, style: { color: "var(--auto)", flexShrink: 0 } }), h("span", { className: "mono hi", style: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, f.name)),
            h("div", { className: "row", style: { gap: 8, flexShrink: 0 } }, h(Badge, { kind: "auto" }, f.copies + " copies"), h(Badge, { kind: "ok" }, "save " + f.recoverGB + " GB")))))),
        cardShell("Largest Cloud Files", "barChart", "var(--tx-mut)", null,
          h("div", { style: { padding: "6px 0" } }, C.largeCloud.map((f, i) => h("div", { key: i, className: "row", style: { padding: "11px 18px", gap: 12, borderBottom: i < C.largeCloud.length - 1 ? "1px solid var(--line-faint)" : "none" } },
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { className: "spread", style: { marginBottom: 5 } }, h("span", { className: "mono hi", style: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, f.name), h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-hi)", flexShrink: 0, marginLeft: 8 } }, f.sizeGB + " GB")),
              h(Bar, { value: f.sizeGB, max: C.largeCloud[0].sizeGB, kind: "cloud", height: 5 })))))) ));
  }

  function syncRec(title, why, risk, icon, cta, toast) {
    return h("div", { className: "spread", style: { padding: "11px 13px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
      h("div", { className: "row", style: { gap: 11, minWidth: 0 } },
        h("span", { style: { width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--" + risk + "-soft)", color: "var(--" + risk + ")" } }, h(Icon, { name: icon, size: 15 })),
        h("div", { style: { minWidth: 0 } }, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 12.5 } }, title), h("div", { className: "muted", style: { fontSize: 11.5 } }, why))),
      h("button", { className: "btn sm", style: { flexShrink: 0 }, onClick: () => toast(cta + " queued", icon, "cloud") }, cta));
  }
  function ckpi(label, value, icon, color) {
    return h("div", { className: "card card-pad fade-up", style: { display: "flex", alignItems: "center", gap: 13 } },
      h("div", { style: { width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--bg-surface)", color, border: "1px solid var(--line)" } }, h(Icon, { name: icon, size: 18 })),
      h("div", null, h("div", { className: "stat-num", style: { fontSize: 21, color } }, value), h("div", { className: "eyebrow", style: { fontSize: 9.5, marginTop: 1 } }, label)));
  }
  function compareCard(title, icon, color, items, note, noteKind, go, risky) {
    return cardShell(title, icon, color, h(Badge, { square: true }, items.length + " items"),
      h("div", null,
        h("div", { style: { padding: "6px 0" } }, items.map((f, i) => h("div", { key: i, className: "spread", style: { padding: "11px 18px", borderBottom: "1px solid var(--line-faint)" } },
          h("div", { className: "row", style: { gap: 9, minWidth: 0 } },
            risky && f.risk === "high" && h(Icon, { name: "alert", size: 14, style: { color: "var(--risk)", flexShrink: 0 } }),
            h("span", { className: "mono", style: { fontSize: 11.5, color: "var(--tx)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, f.name)),
          h("div", { className: "row", style: { gap: 8, flexShrink: 0 } },
            f.risk && h(Badge, { kind: f.risk === "high" ? "risk" : "warn" }, f.risk), h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-hi)" } }, fmtGB(f.sizeGB)))))),
        h("div", { style: { padding: "11px 18px", borderTop: "1px solid var(--line)", background: "var(--" + noteKind + "-soft)", display: "flex", gap: 9, alignItems: "center" } },
          h(Icon, { name: noteKind === "ok" ? "shieldCheck" : "info", size: 14, style: { color: "var(--" + noteKind + ")", flexShrink: 0 } }),
          h("span", { style: { fontSize: 11.5, color: "var(--tx-mut)" } }, note))));
  }

  window.CloudScreen = CloudScreen;
})();
