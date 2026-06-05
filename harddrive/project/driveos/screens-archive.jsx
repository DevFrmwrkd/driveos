/* ============================================================
   DriveOS — Archive + Archive Checklist Modal
   ============================================================ */
(function () {
  const h = window.h, cardShell = window.cardShell;
  const DB = window.DB;

  const CHECKLIST = [
    "Final exports exist", "Raw footage exists", "Project files exist",
    "Music / SFX / license docs exist", "Fonts & graphics exist", "Archive copy verified",
    "Cloud copy verified (if required)", "Checksums generated", "Proxies marked safe to remove",
    "Cache marked safe to remove", "Review exports selected for quarantine", "Status changed to Archived",
  ];

  // ---- Archive Checklist Modal ----
  function ArchiveChecklistModal({ p, onClose, toast, go }) {
    const initial = CHECKLIST.map((_, i) => i < 5 || (p && p.archiveReady > 80 && i < 9));
    const [done, setDone] = React.useState(initial);
    const complete = done.filter(Boolean).length;
    const allDone = complete === CHECKLIST.length;
    const toggle = (i) => setDone((d) => d.map((x, j) => j === i ? !x : x));

    const footer = [
      h("div", { key: "p", className: "row", style: { gap: 10, marginRight: "auto" } },
        h("div", { style: { width: 120 } }, h(Bar, { value: complete, max: CHECKLIST.length, kind: allDone ? "ok" : "warn", height: 6 })),
        h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-mut)" } }, complete + " / " + CHECKLIST.length)),
      h("button", { key: "c", className: "btn", onClick: onClose }, "Cancel"),
      h("button", { key: "m", className: "btn", onClick: () => toast("Checksum manifest generated", "fingerprint", "accent") }, h(Icon, { name: "fingerprint", size: 14 }), "Generate Manifest"),
      h("button", { key: "a", className: "btn primary", disabled: !allDone, onClick: () => { toast((p ? p.name : "Project") + " archived", "archive", "ok"); onClose(); if (go) go("archive"); } },
        h(Icon, { name: "archive", size: 14 }), allDone ? "Mark Archived" : "Complete all items"),
    ];

    return h(Modal, { title: "Archive Checklist" + (p ? " — " + p.name : ""), subtitle: "Step-by-step closeout. Nothing archives until every item is verified.", icon: "archive", iconKind: "auto", onClose, footer, width: 620 },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 7 } }, CHECKLIST.map((c, i) =>
        h("div", { key: i, className: "spread", onClick: () => toggle(i), style: { padding: "11px 13px", borderRadius: "var(--r)", cursor: "pointer", background: done[i] ? "var(--ok-soft)" : "var(--bg-surface)", border: "1px solid " + (done[i] ? "var(--ok-line)" : "var(--line)"), transition: "all .12s" } },
          h("div", { className: "row", style: { gap: 11 } },
            h("span", { className: "chk " + (done[i] ? "on" : ""), style: { background: done[i] ? "var(--ok)" : "var(--bg-input)", borderColor: done[i] ? "var(--ok)" : "var(--line-strong)" } }, h(Icon, { name: "check", size: 12, stroke: 3, style: { color: "#fff", opacity: done[i] ? 1 : 0 } })),
            h("span", { style: { fontSize: 13, fontWeight: 500, color: done[i] ? "var(--tx-hi)" : "var(--tx)" } }, c)),
          h("span", { className: "mono dim", style: { fontSize: 10.5 } }, String(i + 1).padStart(2, "0")))))) ;
  }

  // ---- Archive drive card ----
  function ArchiveDriveCard({ d, go }) {
    const verified = d.id === "vault-a" ? "47 days ago" : d.id === "brandon-arc" ? "6 days ago" : "21 days ago";
    return h("div", { className: "card fade-up", onClick: () => go("drive", { id: d.id }), style: { cursor: "pointer" } },
      h("div", { className: "card-pad" },
        h("div", { className: "spread", style: { marginBottom: 13 } },
          h("div", { className: "row", style: { gap: 11, minWidth: 0 } },
            h("div", { style: { width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--auto-soft)", color: "var(--auto)", border: "1px solid var(--auto-line)" } }, h(Icon, { name: "archive", size: 18 })),
            h("div", { style: { minWidth: 0 } }, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, d.name),
              h("div", { className: "muted", style: { fontSize: 11 } }, d.location))),
          h(StatusBadge, { status: d.status })),
        h(Bar, { value: d.usedTB, max: d.capTB, kind: "", height: 7 }),
        h("div", { className: "spread", style: { fontSize: 11, marginTop: 6 } }, h("span", { className: "mono dim" }, fmtTB(d.usedTB) + " / " + d.capTB + " TB"), h("span", { className: "muted" }, d.projects.length + " projects")),
        h("div", { className: "divider", style: { margin: "13px 0" } }),
        h("div", { className: "spread", style: { fontSize: 11.5 } },
          h("span", { className: "row", style: { gap: 6 } }, h(Icon, { name: "fingerprint", size: 13, style: { color: "var(--ok)" } }), h("span", { className: "muted" }, "Checksum verified")),
          h("span", { className: "mono dim" }, verified))));
  }

  function ArchiveScreen({ go, toast }) {
    const [modal, setModal] = React.useState(null);
    const ready = DB.projects.filter((p) => p.status === "ready" || (p.status === "delivered" && p.archiveReady >= 80));
    const archiveDrives = DB.drives.filter((d) => d.tier === "cold");

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Storage", title: "Archive", desc: "Cold storage and finished projects. Verify redundancy and checksums before a project goes offline for good.",
        actions: [
          h("button", { key: 1, className: "btn", onClick: () => toast("Verifying archive integrity…", "fingerprint", "accent") }, h(Icon, { name: "shieldCheck", size: 15 }), "Verify Archive"),
          h("button", { key: 2, className: "btn primary", onClick: () => setModal({ p: ready[0] }) }, h(Icon, { name: "archive", size: 15 }), "Start Archive Checklist")] }),

      // KPIs
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "var(--gap)", marginBottom: "var(--gap)" } },
        akpi("Ready to Archive", ready.length, "archive", "var(--auto)"),
        akpi("Archive Drives", archiveDrives.length, "server", "var(--tx-hi)"),
        akpi("Cold Storage", fmtTB(DB.tiers.find((t) => t.key === "cold").usedTB), "database", "var(--tx-hi)"),
        akpi("At-risk Projects", 2, "alert", "var(--risk)")),

      // ready to archive
      h("h3", { style: { fontSize: 15, marginBottom: 13 } }, "Projects Ready to Archive"),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)", marginBottom: 26 } },
        ready.map((p) => h(ReadyCard, { key: p.id, p, go, onStart: () => setModal({ p }) }))),

      // archive drives
      h("h3", { style: { fontSize: 15, marginBottom: 13 } }, "Offline Drive Catalog"),
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))", gap: "var(--gap)", marginBottom: 26 } },
        archiveDrives.map((d) => h(ArchiveDriveCard, { key: d.id, d, go }))),

      modal && h(ArchiveChecklistModal, { p: modal.p, onClose: () => setModal(null), toast, go }));
  }

  function ReadyCard({ p, go, onStart }) {
    const risks = [];
    if (p.id === "show-x-old") risks.push("Only one copy exists");
    if (p.archiveReady < 90) risks.push("Cloud copy not verified");
    if (p.structure < 60) risks.push("Project files incomplete");
    const checks = [
      { label: "Final exports", ok: p.archiveReady > 50 },
      { label: "Raw footage verified", ok: p.id !== "show-x-old" },
      { label: "Project files", ok: p.structure > 60 },
      { label: "Checksums generated", ok: p.archiveReady >= 90 },
    ];
    return h("div", { className: "card fade-up" },
      h("div", { className: "card-pad" },
        h("div", { className: "spread", style: { marginBottom: 12 } },
          h("div", { style: { minWidth: 0 } }, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 14.5, cursor: "pointer" }, onClick: () => go("project", { id: p.id }) }, p.name),
            h("div", { className: "muted", style: { fontSize: 11.5, marginTop: 2 } }, p.client + " · " + fmtTB(p.sizeTB) + " · " + p.modified)),
          h("div", { style: { textAlign: "right" } }, h("div", { className: "stat-num", style: { fontSize: 22, color: p.archiveReady >= 90 ? "var(--ok)" : "var(--warn)" } }, p.archiveReady + "%"), h("div", { className: "eyebrow", style: { fontSize: 9 } }, "Ready"))),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 13 } }, checks.map((c, i) =>
          h("div", { key: i, className: "row", style: { gap: 8 } }, h("span", { style: { width: 18, height: 18, borderRadius: 5, display: "grid", placeItems: "center", flexShrink: 0, background: c.ok ? "var(--ok-soft)" : "var(--risk-soft)", color: c.ok ? "var(--ok)" : "var(--risk)" } }, h(Icon, { name: c.ok ? "check" : "x", size: 12, stroke: 3 })),
            h("span", { style: { fontSize: 12, color: c.ok ? "var(--tx)" : "var(--tx-mut)" } }, c.label)))),
        risks.length > 0 && h("div", { style: { padding: "9px 12px", borderRadius: "var(--r)", background: "var(--risk-soft)", border: "1px solid var(--risk-line)", marginBottom: 13 } },
          risks.map((rk, i) => h("div", { key: i, className: "row", style: { gap: 7, fontSize: 11.5, color: "var(--tx)", padding: "1px 0" } }, h(Icon, { name: "alert", size: 12, style: { color: "var(--risk)", flexShrink: 0 } }), rk))),
        h("div", { className: "row", style: { gap: 8 } },
          h("button", { className: "btn primary sm", style: { flex: 1 }, onClick: onStart }, h(Icon, { name: "archive", size: 14 }), "Archive Checklist"),
          h("button", { className: "btn sm", onClick: () => go("project", { id: p.id }) }, "Open"))));
  }

  function akpi(label, value, icon, color) {
    return h("div", { className: "card card-pad fade-up", style: { display: "flex", alignItems: "center", gap: 13 } },
      h("div", { style: { width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--bg-surface)", color, border: "1px solid var(--line)" } }, h(Icon, { name: icon, size: 18 })),
      h("div", null, h("div", { className: "stat-num", style: { fontSize: 21, color } }, value), h("div", { className: "eyebrow", style: { fontSize: 9.5, marginTop: 1 } }, label)));
  }

  window.ArchiveScreen = ArchiveScreen;
  window.ArchiveChecklistModal = ArchiveChecklistModal;
})();
