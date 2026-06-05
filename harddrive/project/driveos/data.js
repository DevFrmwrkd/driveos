/* ============================================================
   DriveOS — mock data (realistic media-production studio)
   Exposed as window.DB
   ============================================================ */
(function () {
  // ---- Team ----
  const team = [
    { id: "cj",      name: "CJ Marlowe",     role: "Lead Editor",        initials: "CJ", color: "#6366f1", location: "Los Angeles", usedTB: 6.2, drives: 3 },
    { id: "brandon", name: "Brandon Pike",   role: "Producer",           initials: "BP", color: "#34d399", location: "Los Angeles", usedTB: 21.4, drives: 4 },
    { id: "mara",    name: "Mara Velez",     role: "Assistant Editor",   initials: "MV", color: "#fbbf24", location: "Los Angeles", usedTB: 3.1, drives: 2 },
    { id: "kenji",   name: "Kenji Saito",    role: "Editor (Japan)",     initials: "KS", color: "#38bdf8", location: "Tokyo",       usedTB: 8.7, drives: 2 },
    { id: "founder", name: "Devon Hart",     role: "Founder / Director", initials: "DH", color: "#a855f7", location: "Los Angeles", usedTB: 1.2, drives: 1 },
  ];
  const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
  const teamById = byId(team);

  // ---- Drives ----
  const drives = [
    { id: "cj-ssd",     name: "CJ Working SSD",        owner: "cj",      location: "Los Angeles", status: "online",  tier: "hot",   bus: "Thunderbolt 4", model: "OWC Envoy Pro FX 4TB",   capTB: 4,  usedTB: 3.6,  lastSeen: "now",          risk: "high",   projects: ["show-x", "japan-ep"], dupTB: 0.42, cleanTB: 0.61, scans: 142 },
    { id: "brandon-arc",name: "Brandon Archive 01",    owner: "brandon", location: "Los Angeles", status: "offline", tier: "cold",  bus: "USB 3.2",       model: "Synology HAT5300 18TB",  capTB: 18, usedTB: 15.2, lastSeen: "6 days ago",   risk: "medium", projects: ["show-x-old","client-launch","podcast-12"], dupTB: 1.9, cleanTB: 0.0, scans: 31 },
    { id: "master-02",  name: "Studio Master Drive 02",owner: "brandon", location: "Los Angeles", status: "online",  tier: "warm",  bus: "Thunderbolt 4", model: "OWC ThunderBay 8 20TB",  capTB: 20, usedTB: 12.8, lastSeen: "now",          risk: "low",    projects: ["japan-ep","client-launch","brand-films"], dupTB: 0.74, cleanTB: 1.4, scans: 88 },
    { id: "cj-shuttle", name: "CJ Shuttle SSD 02",     owner: "cj",      location: "Los Angeles", status: "online",  tier: "hot",   bus: "Thunderbolt 3", model: "Samsung X5 2TB",         capTB: 2,  usedTB: 1.5,  lastSeen: "now",          risk: "medium", projects: ["show-x"], dupTB: 0.18, cleanTB: 0.34, scans: 57 },
    { id: "mara-raid",  name: "Ingest RAID (Mara)",    owner: "mara",    location: "Los Angeles", status: "online",  tier: "hot",   bus: "Thunderbolt 4", model: "OWC ThunderBay 4 mini",  capTB: 8,  usedTB: 3.1,  lastSeen: "12 min ago",   risk: "low",    projects: ["brand-films","social-q3"], dupTB: 0.26, cleanTB: 0.5, scans: 64 },
    { id: "japan-new",  name: "Japan New Storage 01",  owner: "kenji",   location: "Tokyo",       status: "uninit",  tier: "warm",  bus: "USB-C",         model: "LaCie 2big RAID 20TB",   capTB: 20, usedTB: 0,    lastSeen: "never",        risk: "none",   projects: [], dupTB: 0, cleanTB: 0, scans: 0 },
    { id: "japan-work", name: "Kenji Working SSD",     owner: "kenji",   location: "Tokyo",       status: "online",  tier: "hot",   bus: "Thunderbolt 4", model: "OWC Envoy Pro FX 4TB",   capTB: 4,  usedTB: 2.9,  lastSeen: "now",          risk: "medium", projects: ["japan-ep"], dupTB: 0.31, cleanTB: 0.44, scans: 39 },
    { id: "brandon-arc2",name: "Brandon Archive 02",   owner: "brandon", location: "Los Angeles", status: "offline", tier: "cold",  bus: "USB 3.2",       model: "Synology HAT5300 18TB",  capTB: 18, usedTB: 9.4,  lastSeen: "21 days ago",  risk: "medium", projects: ["brand-films","podcast-12"], dupTB: 0.6, cleanTB: 0, scans: 12 },
    { id: "gdrive",     name: "Google Drive Ultra",    owner: "founder", location: "Cloud",       status: "cloud",   tier: "cloud", bus: "Cloud · OAuth", model: "Google Workspace",       capTB: 20, usedTB: 13.4, lastSeen: "now",          risk: "low",    projects: ["show-x","client-launch","japan-ep","social-q3"], dupTB: 1.1, cleanTB: 0.9, scans: 24 },
    { id: "vault-a",    name: "Vault Drive A (offsite)",owner: "founder",location: "Iron Mtn · NV",status: "offline", tier: "cold",  bus: "USB 3.2",       model: "Seagate Exos 16TB",      capTB: 16, usedTB: 7.8,  lastSeen: "47 days ago",  risk: "low",    projects: ["client-launch","podcast-12"], dupTB: 0, cleanTB: 0, scans: 4 },
  ];
  const driveById = byId(drives);

  // ---- Projects ----
  const projects = [
    { id: "show-x",       name: "Show X — Ep. 214",          client: "Show X Media",       show: "Show X (YouTube)",     owner: "cj",      status: "active",   tier: "hot",   sizeTB: 2.8,  dupTB: 0.42, cleanTB: 0.61, modified: "2h ago",   structure: 96, archiveReady: 12, locations: ["cj-ssd","cj-shuttle","gdrive"], template: "YouTube Show" },
    { id: "japan-ep",     name: "Japan Travel — Episode 03", client: "Wander Co.",         show: "Wander Series",        owner: "kenji",   status: "review",   tier: "warm",  sizeTB: 1.6,  dupTB: 0.31, cleanTB: 0.52, modified: "1d ago",   structure: 78, archiveReady: 41, locations: ["japan-work","master-02","gdrive"], template: "Documentary" },
    { id: "client-launch",name: "Client Launch Campaign",    client: "Northwind",          show: "Q2 Product Launch",    owner: "brandon", status: "delivered",tier: "warm",  sizeTB: 0.92, dupTB: 0.21, cleanTB: 0.38, modified: "9d ago",   structure: 88, archiveReady: 84, locations: ["master-02","brandon-arc","gdrive","vault-a"], template: "Commercial Campaign" },
    { id: "podcast-12",   name: "Podcast Shorts — Batch 12", client: "Soundwave",          show: "Soundwave Pod",        owner: "mara",    status: "archived", tier: "cold",  sizeTB: 0.46, dupTB: 0.04, cleanTB: 0.02, modified: "38d ago",  structure: 92, archiveReady: 100, locations: ["brandon-arc","brandon-arc2","vault-a"], template: "Podcast Shorts" },
    { id: "brand-films",  name: "Brand Films — Atlas Motors", client: "Atlas Motors",      show: "Atlas Spring 2026",    owner: "mara",    status: "active",   tier: "hot",   sizeTB: 2.1,  dupTB: 0.33, cleanTB: 0.47, modified: "5h ago",   structure: 64, archiveReady: 8,  locations: ["mara-raid","master-02","brandon-arc2"], template: "Commercial Campaign" },
    { id: "social-q3",    name: "Social Cutdowns — Q3",      client: "Internal",           show: "Studio Social",        owner: "mara",    status: "review",   tier: "hot",   sizeTB: 0.58, dupTB: 0.12, cleanTB: 0.21, modified: "3d ago",   structure: 71, archiveReady: 22, locations: ["mara-raid","gdrive"], template: "Custom" },
    { id: "show-x-old",   name: "Show X — Ep. 198 (old)",    client: "Show X Media",       show: "Show X (YouTube)",     owner: "brandon", status: "ready",    tier: "cold",  sizeTB: 1.3,  dupTB: 0.51, cleanTB: 0.18, modified: "62d ago",  structure: 54, archiveReady: 76, locations: ["brandon-arc"], template: "YouTube Show" },
  ];
  const projectById = byId(projects);

  // ---- File-type breakdown (TB), studio-wide ----
  const fileTypes = [
    { key: "raw",     label: "RAW Footage",     tb: 38.4, color: "var(--ft-raw)" },
    { key: "stock",   label: "Stock Footage",   tb: 9.6,  color: "var(--ft-stock)" },
    { key: "proxy",   label: "Proxies",         tb: 7.2,  color: "var(--ft-proxy)" },
    { key: "export",  label: "Exports",         tb: 6.1,  color: "var(--ft-export)" },
    { key: "cache",   label: "Cache / Renders", tb: 5.3,  color: "var(--ft-cache)" },
    { key: "audio",   label: "Audio",           tb: 3.4,  color: "var(--ft-audio)" },
    { key: "gfx",     label: "Graphics / AE",   tb: 2.6,  color: "var(--ft-gfx)" },
    { key: "unknown", label: "Unknown",         tb: 2.2,  color: "var(--ft-unknown)" },
  ];

  // ---- Storage tiers ----
  const tiers = [
    { key: "hot",   label: "Hot — Working SSD",  usedTB: 11.6, capTB: 18,  color: "var(--risk)",  desc: "Live editing drives" },
    { key: "warm",  label: "Warm — Near-line",   usedTB: 22.0, capTB: 40,  color: "var(--warn)",  desc: "Recent / staged" },
    { key: "cloud", label: "Cloud — Google Drive",usedTB: 13.4, capTB: 20, color: "var(--cloud)", desc: "Shared + delivery" },
    { key: "cold",  label: "Cold — Archive",     usedTB: 27.8, capTB: 70,  color: "var(--auto)",  desc: "Offline catalog" },
  ];

  // ---- Duplicate clusters ----
  const duplicates = [
    {
      id: "dup1", name: "A001_C004.mov", type: "raw", sizeGB: 186, copies: 3, kind: "exact", risk: "review",
      project: "show-x", owner: "cj", modified: "2026-04-18", fingerprint: "xxh64:9f3a…b1c", recoverGB: 186,
      locations: [
        { path: "/CJ_Working/Show_X/02_RAW/A_CAM/A001_C004.mov", drive: "cj-ssd", role: "keep", tag: "Working copy" },
        { path: "/Brandon_Drive/Show_X_OLD/A001_C004.mov", drive: "brandon-arc", role: "quarantine", tag: "Stale duplicate" },
        { path: "/GoogleDrive/Archive/Show_X/RAW/A001_C004.mov", drive: "gdrive", role: "keep", tag: "Archive copy" },
      ],
      rec: "Keep the archive copy and current working copy. Quarantine the old Brandon copy. Recover 186 GB.",
    },
    {
      id: "dup2", name: "city_timelapse_4k.mp4", type: "stock", sizeGB: 24, copies: 5, kind: "stock", risk: "safe",
      project: "—", owner: "mara", modified: "2026-02-02", fingerprint: "xxh64:4b71…02e", recoverGB: 96,
      locations: [
        { path: "/Ingest_RAID/Stock/city_timelapse_4k.mp4", drive: "mara-raid", role: "keep", tag: "Stock library" },
        { path: "/CJ_Working/Show_X/04_ASSETS/STOCK_FOOTAGE/city_timelapse_4k.mp4", drive: "cj-ssd", role: "quarantine", tag: "Project copy" },
        { path: "/Master_02/Brand_Films/STOCK/city_timelapse_4k.mp4", drive: "master-02", role: "quarantine", tag: "Project copy" },
        { path: "/Master_02/Client_Launch/STOCK/city_timelapse_4k.mp4", drive: "master-02", role: "quarantine", tag: "Project copy" },
        { path: "/GoogleDrive/Social_Q3/STOCK/city_timelapse_4k.mp4", drive: "gdrive", role: "quarantine", tag: "Project copy" },
      ],
      rec: "Centralize to the shared Stock library and link. Quarantine 4 project copies. Recover 96 GB.",
    },
    {
      id: "dup3", name: "EP214_FINAL_v7.mov", type: "export", sizeGB: 42, copies: 2, kind: "samename", risk: "danger",
      project: "show-x", owner: "cj", modified: "2026-05-29", fingerprint: "xxh64:c0d2…7af", recoverGB: 0,
      locations: [
        { path: "/CJ_Working/Show_X/07_EXPORTS/FINAL/EP214_FINAL_v7.mov", drive: "cj-ssd", role: "keep", tag: "Final master" },
        { path: "/GoogleDrive/Show_X/Delivery/EP214_FINAL_v7.mov", drive: "gdrive", role: "keep", tag: "Delivery copy" },
      ],
      rec: "Both copies are final deliverables on separate tiers — do not delete. Marked intentional redundancy.",
    },
    {
      id: "dup4", name: "B_ROLL_drone_0042.mp4", type: "raw", sizeGB: 58, copies: 3, kind: "likely", risk: "review",
      project: "japan-ep", owner: "kenji", modified: "2026-03-11", fingerprint: "xxh64:7e19…d4a", recoverGB: 116,
      locations: [
        { path: "/Kenji_SSD/Japan_Ep03/02_RAW/DRONE/B_ROLL_drone_0042.mp4", drive: "japan-work", role: "keep", tag: "Working copy" },
        { path: "/Master_02/Japan_Ep03/RAW/DRONE/B_ROLL_drone_0042.mp4", drive: "master-02", role: "quarantine", tag: "Staged copy" },
        { path: "/GoogleDrive/Japan_Ep03/RAW/B_ROLL_drone_0042.mp4", drive: "gdrive", role: "review", tag: "Cloud copy" },
      ],
      rec: "Likely identical (same size, fingerprint match). Keep working copy; review cloud copy before quarantine. Recover up to 116 GB.",
    },
    {
      id: "dup5", name: "intro_sting_master.wav", type: "audio", sizeGB: 1.2, copies: 6, kind: "exact", risk: "safe",
      project: "—", owner: "mara", modified: "2025-12-08", fingerprint: "xxh64:1aa0…99f", recoverGB: 6,
      locations: [
        { path: "/Ingest_RAID/Audio/Library/intro_sting_master.wav", drive: "mara-raid", role: "keep", tag: "Master" },
        { path: "/CJ_Working/Show_X/04_ASSETS/SFX/intro_sting_master.wav", drive: "cj-ssd", role: "quarantine", tag: "Copy" },
        { path: "/Master_02/Brand_Films/SFX/intro_sting_master.wav", drive: "master-02", role: "quarantine", tag: "Copy" },
      ],
      rec: "Six identical copies of the studio sting. Keep library master, quarantine 5 copies. Recover 6 GB.",
    },
  ];

  // ---- Cleanup recommendations ----
  const cleanup = [
    { id: "c1", title: "Premiere & DaVinci cache", cat: "Cache", risk: "safe", recoverTB: 2.4, files: 18420, projects: ["show-x","brand-films","japan-ep","social-q3"], approval: false,
      why: "Regenerable cache and peak files from Premiere Pro and DaVinci Resolve. Rebuilt automatically on next open.", action: "Move to quarantine, auto-purge in 14 days." },
    { id: "c2", title: "Generated proxies (delivered projects)", cat: "Proxies", risk: "safe", recoverTB: 1.7, files: 6240, projects: ["client-launch","podcast-12"], approval: false,
      why: "Proxy media for projects already delivered. Originals (RAW) verified present on archive.", action: "Quarantine proxies; RAW remains untouched." },
    { id: "c3", title: "Duplicate stock footage across projects", cat: "Duplicate stock", risk: "safe", recoverTB: 1.1, files: 312, projects: ["show-x","brand-films","client-launch","social-q3"], approval: false,
      why: "Identical stock clips copied into multiple project folders instead of linked from the shared library.", action: "Centralize to Stock library, quarantine project copies." },
    { id: "c4", title: "Old review exports (v1–v6)", cat: "Review exports", risk: "review", recoverTB: 1.5, files: 884, projects: ["show-x","japan-ep","brand-films"], approval: true,
      why: "Superseded review exports older than the latest approved cut. Final masters are kept separately.", action: "Quarantine after producer approval; 30-day rollback." },
    { id: "c5", title: "Abandoned project copy — Show X Ep.198", cat: "Abandoned copies", risk: "review", recoverTB: 0.9, files: 2210, projects: ["show-x-old"], approval: true,
      why: "Duplicate of a delivered episode on Brandon Archive 01 with no edits in 62 days. Archive copy exists.", action: "Verify archive checksum, then quarantine working duplicate." },
    { id: "c6", title: "Duplicate downloads (LUTs, fonts, music)", cat: "Duplicate downloads", risk: "safe", recoverTB: 0.6, files: 1490, projects: ["brand-films","social-q3","show-x"], approval: false,
      why: "Repeatedly downloaded LUT packs, font kits, and licensed tracks duplicated per project.", action: "Quarantine duplicates; keep one library copy." },
    { id: "c7", title: "Unknown large files (> 5 GB)", cat: "Unknown", risk: "danger", recoverTB: 0.4, files: 36, projects: ["—"], approval: true,
      why: "Large files DriveOS could not classify (no media header, unusual container). Manual review required.", action: "Do not auto-clean. Flag for editor review." },
    { id: "c8", title: "Render previews & auto-saves", cat: "Cache", risk: "safe", recoverTB: 0.3, files: 9870, projects: ["show-x","brand-films","japan-ep"], approval: false,
      why: "Auto-save backups and render preview files beyond the keep-3 retention rule.", action: "Quarantine older than latest 3 auto-saves." },
  ];

  // ---- Quarantine ----
  const quarantine = [
    { id: "q1", name: "Show_X_OLD/A001_C004.mov", origin: "/Brandon_Drive/Show_X_OLD/A001_C004.mov", qpath: "/_QUARANTINE/2026-06-03/A001_C004.mov", reason: "Exact duplicate of working + archive copy", by: "mara", date: "2026-06-03", deadline: "2026-07-03", sizeGB: 186, verified: true },
    { id: "q2", name: "Premiere cache (Brand Films)", origin: "/Ingest_RAID/Brand_Films/06_RENDERS_CACHE/", qpath: "/_QUARANTINE/2026-06-02/brandfilms_cache/", reason: "Regenerable cache — auto rule", by: "DriveOS Agent", date: "2026-06-02", deadline: "2026-06-16", sizeGB: 612, verified: true },
    { id: "q3", name: "EP03_REVIEW_v3.mov", origin: "/Kenji_SSD/Japan_Ep03/07_EXPORTS/REVIEW/EP03_REVIEW_v3.mov", qpath: "/_QUARANTINE/2026-05-30/EP03_REVIEW_v3.mov", reason: "Superseded review export", by: "kenji", date: "2026-05-30", deadline: "2026-06-29", sizeGB: 38, verified: true },
    { id: "q4", name: "city_timelapse_4k.mp4 (×4)", origin: "/Multiple project folders", qpath: "/_QUARANTINE/2026-05-28/stock_dupes/", reason: "Duplicate stock — centralized to library", by: "mara", date: "2026-05-28", deadline: "2026-06-27", sizeGB: 72, verified: true },
  ];

  // ---- Audit log ----
  const audit = [
    { time: "11:42", date: "Jun 3", who: "Mara Velez", action: "Quarantined A001_C004.mov (186 GB) from Brandon Archive 01", kind: "quarantine" },
    { time: "09:18", date: "Jun 3", who: "DriveOS Agent", action: "Scan complete · CJ Working SSD · 142,308 files indexed", kind: "scan" },
    { time: "17:05", date: "Jun 2", who: "DriveOS Agent", action: "Auto-quarantined Brand Films cache (612 GB) per cleanup rule", kind: "auto" },
    { time: "14:30", date: "Jun 2", who: "Brandon Pike", action: "Approved cleanup plan: Client Launch — Delivered (380 GB)", kind: "approve" },
    { time: "10:52", date: "Jun 1", who: "CJ Marlowe", action: "Created project: Show X — Ep. 214 (YouTube Show template)", kind: "create" },
    { time: "16:20", date: "May 30", who: "Kenji Saito", action: "Restored EP03_REVIEW_v4.mov from quarantine", kind: "restore" },
  ];

  // ---- Recently connected drives (event feed) ----
  const driveEvents = [
    { drive: "cj-ssd", event: "connected", time: "2 min ago", detail: "Thunderbolt 4 · auto-scan started" },
    { drive: "mara-raid", event: "scan", time: "12 min ago", detail: "Scan complete · 64,201 files" },
    { drive: "japan-work", event: "connected", time: "38 min ago", detail: "Tokyo agent · online" },
    { drive: "brandon-arc", event: "offline", time: "6 days ago", detail: "Last seen LA studio" },
  ];

  // ---- Active warnings ----
  const warnings = [
    { id: "w1", risk: "risk", title: "CJ Working SSD is 90% full", detail: "Only 0.4 TB free on a live editing drive. Cleanup can recover 0.61 TB.", action: "Clean Up", target: "drive:cj-ssd" },
    { id: "w2", risk: "risk", title: "Single copy: Brand Films RAW", detail: "147 RAW clips (0.9 TB) exist only on Ingest RAID. No archive or cloud copy.", action: "Archive", target: "project:brand-films" },
    { id: "w3", risk: "warn", title: "Japan Storage 01 not initialized", detail: "New 20 TB drive in Tokyo detected but not set up for tracking.", action: "Initialize", target: "drive:japan-new" },
    { id: "w4", risk: "warn", title: "Brand Films breaks folder template", detail: "Missing 03_PROJECT_FILES and 09_ARCHIVE_MANIFEST. Structure health 64%.", action: "Fix Structure", target: "project:brand-films" },
    { id: "w5", risk: "warn", title: "Client Launch ready to archive", detail: "Delivered 9 days ago. Archive readiness 84%. 2 checklist items remain.", action: "Archive", target: "project:client-launch" },
  ];

  // ---- Cloud-specific ----
  const cloud = {
    account: "studio@driveos.media", provider: "Google Workspace", usedTB: 13.4, capTB: 20,
    inCloudNotLocal: [
      { name: "Show_X/Delivery/EP214_FINAL_v7.mov", sizeGB: 42, project: "show-x" },
      { name: "Client_Launch/FINAL/Northwind_Launch_60s.mov", sizeGB: 18, project: "client-launch" },
      { name: "Wander/EP03_socialpack.zip", sizeGB: 6, project: "japan-ep" },
    ],
    localNotCloud: [
      { name: "Brand_Films/07_EXPORTS/FINAL/Atlas_Spring_Hero.mov", sizeGB: 36, project: "brand-films", risk: "high" },
      { name: "Show_X/02_RAW/A_CAM (147 clips)", sizeGB: 920, project: "show-x", risk: "medium" },
    ],
    dupCloud: [
      { name: "city_timelapse_4k.mp4", copies: 3, sizeGB: 24, recoverGB: 48 },
      { name: "intro_sting_master.wav", copies: 4, sizeGB: 1.2, recoverGB: 3.6 },
    ],
    largeCloud: [
      { name: "EP214_FINAL_v7.mov", sizeGB: 42, project: "show-x" },
      { name: "Atlas_brand_reel_4k.mov", sizeGB: 31, project: "brand-films" },
      { name: "Wander_EP03_master.mov", sizeGB: 28, project: "japan-ep" },
    ],
  };

  // ---- Folder template (Create Project Wizard) ----
  const folderTemplate = [
    { name: "00_ADMIN", lvl: 0 },
    { name: "01_BRIEF", lvl: 0 },
    { name: "02_RAW", lvl: 0 },
    { name: "A_CAM", lvl: 1 }, { name: "B_CAM", lvl: 1 }, { name: "AUDIO", lvl: 1 }, { name: "DRONE", lvl: 1 }, { name: "SCREEN_RECORDINGS", lvl: 1 },
    { name: "03_PROJECT_FILES", lvl: 0 },
    { name: "PREMIERE", lvl: 1 }, { name: "AFTER_EFFECTS", lvl: 1 }, { name: "DAVINCI", lvl: 1 },
    { name: "04_ASSETS", lvl: 0 },
    { name: "MUSIC", lvl: 1 }, { name: "SFX", lvl: 1 }, { name: "STOCK_FOOTAGE", lvl: 1 }, { name: "GRAPHICS", lvl: 1 }, { name: "FONTS", lvl: 1 }, { name: "LUTS", lvl: 1 },
    { name: "05_PROXIES", lvl: 0 },
    { name: "06_RENDERS_CACHE", lvl: 0 },
    { name: "07_EXPORTS", lvl: 0 },
    { name: "REVIEW", lvl: 1 }, { name: "FINAL", lvl: 1 }, { name: "SOCIAL_CUTDOWNS", lvl: 1 },
    { name: "08_DELIVERY", lvl: 0 },
    { name: "09_ARCHIVE_MANIFEST", lvl: 0 },
  ];

  const templates = [
    { id: "youtube", name: "YouTube Show", desc: "Episodic · proxies + social cutdowns", folders: 27 },
    { id: "commercial", name: "Commercial Campaign", desc: "Client deliverables · multi-version", folders: 24 },
    { id: "podcast", name: "Podcast Shorts", desc: "Audio-first · batch episodes", folders: 18 },
    { id: "doc", name: "Documentary", desc: "Long-form · heavy RAW + archive", folders: 31 },
    { id: "custom", name: "Custom", desc: "Start from a blank structure", folders: 0 },
  ];

  // ---- Project detail: folder health (for Project Detail screen) ----
  const projectFolders = {
    "show-x": [
      { name: "00_ADMIN", status: "ok", sizeGB: 0.2 },
      { name: "01_BRIEF", status: "ok", sizeGB: 0.1 },
      { name: "02_RAW", status: "ok", sizeGB: 1840 },
      { name: "03_PROJECT_FILES", status: "ok", sizeGB: 4.2 },
      { name: "04_ASSETS", status: "ok", sizeGB: 96 },
      { name: "05_PROXIES", status: "warn", sizeGB: 410, note: "Can be removed after delivery" },
      { name: "06_RENDERS_CACHE", status: "warn", sizeGB: 280, note: "Regenerable cache" },
      { name: "07_EXPORTS", status: "ok", sizeGB: 88 },
      { name: "08_DELIVERY", status: "ok", sizeGB: 42 },
      { name: "09_ARCHIVE_MANIFEST", status: "missing", sizeGB: 0, note: "Required folder missing" },
    ],
  };

  // ---- Search index ----
  const searchSample = {
    query: "A001_C004",
    file: { name: "A001_C004.mov", sizeGB: 186, type: "RAW · ProRes 4444", modified: "2026-04-18", camera: "ARRI Alexa Mini LF", duration: "04:12" },
    found: [
      { drive: "cj-ssd", path: "/CJ_Working/Show_X/02_RAW/A_CAM/A001_C004.mov", role: "working", status: "online" },
      { drive: "brandon-arc", path: "/Brandon_Drive/Show_X_OLD/A001_C004.mov", role: "duplicate", status: "offline" },
      { drive: "gdrive", path: "/GoogleDrive/Archive/Show_X/RAW/A001_C004.mov", role: "archive", status: "cloud" },
    ],
  };

  // ---- KPIs (dashboard) ----
  const kpi = {
    totalTB: 74.8, cleanupTB: 8.6, dupTB: 4.2, proxyCacheTB: 2.9, reviewExportsTB: 1.5,
    drivesOnline: 6, drivesOffline: 9, cloudUsedTB: 13.4, cloudCapTB: 20, health: 68,
    healthTrend: [61, 63, 62, 65, 64, 66, 68], readyToArchive: 3,
  };

  window.DB = {
    team, teamById, drives, driveById, projects, projectById, fileTypes, tiers,
    duplicates, cleanup, quarantine, audit, driveEvents, warnings, cloud,
    folderTemplate, templates, projectFolders, searchSample, kpi,
  };
})();
