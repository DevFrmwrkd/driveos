import { mutation } from "./_generated/server";
import { deriveAlerts } from "@driveos/shared";

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const timestamp = Date.now();

    // 1) Clear any existing data in tables to ensure clean state
    const existingMembers = await ctx.db.query("teamMembers").collect();
    for (const x of existingMembers) await ctx.db.delete(x._id);

    const existingDrives = await ctx.db.query("drives").collect();
    for (const x of existingDrives) await ctx.db.delete(x._id);

    const existingProjects = await ctx.db.query("projects").collect();
    for (const x of existingProjects) await ctx.db.delete(x._id);

    const existingTemplates = await ctx.db.query("folderTemplates").collect();
    for (const x of existingTemplates) await ctx.db.delete(x._id);

    const existingClusters = await ctx.db.query("duplicateClusters").collect();
    for (const x of existingClusters) await ctx.db.delete(x._id);

    const existingRecommendations = await ctx.db.query("recommendations").collect();
    for (const x of existingRecommendations) await ctx.db.delete(x._id);

    const existingQuarantine = await ctx.db.query("quarantineItems").collect();
    for (const x of existingQuarantine) await ctx.db.delete(x._id);

    const existingLogs = await ctx.db.query("auditLogs").collect();
    for (const x of existingLogs) await ctx.db.delete(x._id);

    const existingConnections = await ctx.db.query("cloudConnections").collect();
    for (const x of existingConnections) await ctx.db.delete(x._id);

    const existingCloudFiles = await ctx.db.query("cloudFiles").collect();
    for (const x of existingCloudFiles) await ctx.db.delete(x._id);

    const existingFiles = await ctx.db.query("files").collect();
    for (const x of existingFiles) await ctx.db.delete(x._id);

    const existingJobs = await ctx.db.query("cleanupJobs").collect();
    for (const x of existingJobs) await ctx.db.delete(x._id);

    const existingNotifications = await ctx.db.query("notifications").collect();
    for (const x of existingNotifications) await ctx.db.delete(x._id);

    // Helper: TB to Bytes
    const tb = (n: number) => Math.round(n * 1024 * 1024 * 1024 * 1024);
    const gb = (n: number) => Math.round(n * 1024 * 1024 * 1024);

    // 2) Seed Team Members
    const membersData = [
      { id: "cj",      name: "CJ Marlowe",     email: "cj@driveos.media",       role: "editor",           location: "Los Angeles", usedTB: 6.2, drives: 3 },
      { id: "brandon", name: "Brandon Pike",   email: "brandon@driveos.media",  role: "producer",         location: "Los Angeles", usedTB: 21.4, drives: 4 },
      { id: "mara",    name: "Mara Velez",     email: "mara@driveos.media",     role: "assistant_editor", location: "Los Angeles", usedTB: 3.1, drives: 2 },
      { id: "kenji",   name: "Kenji Saito",    email: "kenji@driveos.media",    role: "editor",           location: "Tokyo",       usedTB: 8.7, drives: 2 },
      { id: "founder", name: "Devon Hart",     email: "devon@driveos.media",    role: "admin",            location: "Los Angeles", usedTB: 1.2, drives: 1 },
    ];

    const memberIdMap: Record<string, string> = {};
    for (const m of membersData) {
      const id = await ctx.db.insert("teamMembers", {
        name: m.name,
        email: m.email,
        role: m.role,
        avatarUrl: `https://api.dicebear.com/7.x/adventurer/svg?seed=${m.name}`,
        location: m.location,
        usedTB: m.usedTB,
        drives: m.drives,
        createdAt: timestamp,
      });
      memberIdMap[m.id] = id;
    }

    // 3) Seed Folder Templates
    const templatesData = [
      {
        id: "youtube",
        name: "YouTube Show",
        description: "Episodic · proxies + social cutdowns",
        tree: [
          { name: "00_ADMIN", lvl: 0 },
          { name: "CONTRACTS", lvl: 1 },
          { name: "LICENSES", lvl: 1 },
          { name: "01_BRIEF", lvl: 0 },
          { name: "02_RAW", lvl: 0 },
          { name: "A_CAM", lvl: 1 },
          { name: "B_CAM", lvl: 1 },
          { name: "AUDIO", lvl: 1 },
          { name: "03_PROJECT_FILES", lvl: 0 },
          { name: "PREMIERE", lvl: 1 },
          { name: "04_ASSETS", lvl: 0 },
          { name: "MUSIC", lvl: 1 },
          { name: "STOCK_FOOTAGE", lvl: 1 },
          { name: "05_PROXIES", lvl: 0 },
          { name: "06_RENDERS_CACHE", lvl: 0 },
          { name: "07_EXPORTS", lvl: 0 },
          { name: "REVIEW", lvl: 1 },
          { name: "FINAL", lvl: 1 },
          { name: "08_DELIVERY", lvl: 0 },
          { name: "09_ARCHIVE_MANIFEST", lvl: 0 },
        ],
        rules: { raw: "never_auto_delete", proxies: "safe_after_delivery", cache: "safe_after_confirmation" },
        isDefault: true,
      },
      {
        id: "commercial",
        name: "Commercial Campaign",
        description: "Client deliverables · multi-version",
        tree: [
          { name: "00_ADMIN", lvl: 0 },
          { name: "01_BRIEF", lvl: 0 },
          { name: "02_RAW", lvl: 0 },
          { name: "A_CAM", lvl: 1 },
          { name: "B_CAM", lvl: 1 },
          { name: "03_PROJECT_FILES", lvl: 0 },
          { name: "DAVINCI", lvl: 1 },
          { name: "04_ASSETS", lvl: 0 },
          { name: "05_PROXIES", lvl: 0 },
          { name: "06_RENDERS_CACHE", lvl: 0 },
          { name: "07_EXPORTS", lvl: 0 },
          { name: "REVIEW", lvl: 1 },
          { name: "FINAL", lvl: 1 },
          { name: "08_DELIVERY", lvl: 0 },
        ],
        rules: { raw: "never_auto_delete", proxies: "safe_after_delivery" },
        isDefault: false,
      },
      {
        id: "podcast",
        name: "Podcast Shorts",
        description: "Audio-first · batch episodes",
        tree: [
          { name: "00_ADMIN", lvl: 0 },
          { name: "01_BRIEF", lvl: 0 },
          { name: "02_RAW_AUDIO", lvl: 0 },
          { name: "03_PROJECT_FILES", lvl: 0 },
          { name: "04_ASSETS", lvl: 0 },
          { name: "05_EXPORTS", lvl: 0 },
        ],
        rules: { raw: "never_auto_delete" },
        isDefault: false,
      },
      {
        id: "doc",
        name: "Documentary",
        description: "Long-form · heavy RAW + archive",
        tree: [
          { name: "00_ADMIN", lvl: 0 },
          { name: "01_BRIEF", lvl: 0 },
          { name: "02_RAW", lvl: 0 },
          { name: "03_PROJECT_FILES", lvl: 0 },
          { name: "04_ASSETS", lvl: 0 },
          { name: "05_PROXIES", lvl: 0 },
          { name: "06_EXPORTS", lvl: 0 },
          { name: "07_ARCHIVE_MANIFEST", lvl: 0 },
        ],
        rules: { raw: "never_auto_delete" },
        isDefault: false,
      },
    ];

    const templateIdMap: Record<string, string> = {};
    for (const t of templatesData) {
      const id = await ctx.db.insert("folderTemplates", {
        name: t.name,
        description: t.description,
        tree: t.tree,
        rules: t.rules,
        isDefault: t.isDefault,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      templateIdMap[t.id] = id;
    }

    // 4) Seed Projects
    const projectsData = [
      { id: "show-x",       name: "Show X — Ep. 214",          client: "Show X Media",       show: "Show X (YouTube)",     owner: "cj",      status: "active",   tier: "hot",   sizeTB: 2.8,  dupTB: 0.42, cleanTB: 0.61, template: "youtube" },
      { id: "japan-ep",     name: "Japan Travel — Episode 03", client: "Wander Co.",         show: "Wander Series",        owner: "kenji",   status: "review",   tier: "warm",  sizeTB: 1.6,  dupTB: 0.31, cleanTB: 0.52, template: "doc" },
      { id: "client-launch",name: "Client Launch Campaign",    client: "Northwind",          show: "Q2 Product Launch",    owner: "brandon", status: "delivered",tier: "warm",  sizeTB: 0.92, dupTB: 0.21, cleanTB: 0.38, template: "commercial" },
      { id: "podcast-12",   name: "Podcast Shorts — Batch 12", client: "Soundwave",          show: "Soundwave Pod",        owner: "mara",    status: "archived", tier: "cold",  sizeTB: 0.46, dupTB: 0.04, cleanTB: 0.02, template: "podcast" },
      { id: "brand-films",  name: "Brand Films — Atlas Motors", client: "Atlas Motors",      show: "Atlas Spring 2026",    owner: "mara",    status: "active",   tier: "hot",   sizeTB: 2.1,  dupTB: 0.33, cleanTB: 0.47, template: "commercial" },
      { id: "social-q3",    name: "Social Cutdowns — Q3",      client: "Internal",           show: "Studio Social",        owner: "mara",    status: "review",   tier: "hot",   sizeTB: 0.58, dupTB: 0.12, cleanTB: 0.21, template: "youtube" },
      { id: "show-x-old",   name: "Show X — Ep. 198 (old)",    client: "Show X Media",       show: "Show X (YouTube)",     owner: "brandon", status: "ready_to_archive", tier: "cold", sizeTB: 1.3, dupTB: 0.51, cleanTB: 0.18, template: "youtube" },
    ];

    const projectIdMap: Record<string, string> = {};
    for (const p of projectsData) {
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const id = await ctx.db.insert("projects", {
        name: p.name,
        client: p.client,
        showName: p.show,
        episode: p.id.includes("ep") ? "03" : undefined,
        slug,
        ownerId: memberIdMap[p.owner] || memberIdMap["founder"],
        status: p.status,
        tier: p.tier,
        folderTemplateId: templateIdMap[p.template],
        template: p.template === "youtube" ? "YouTube Show" : p.template === "commercial" ? "Commercial Campaign" : p.template === "podcast" ? "Podcast Shorts" : "Documentary",
        createdAt: timestamp - (30 * 24 * 60 * 60 * 1000), // created 30 days ago
        storageHealthScore: Math.round(70 + Math.random() * 30),
        totalBytes: tb(p.sizeTB),
        duplicateBytes: tb(p.dupTB),
        safeCleanupBytes: tb(p.cleanTB),
        riskyBytes: p.id === "brand-films" ? tb(0.9) : 0, // 0.9TB risk for Brand Films
      });
      projectIdMap[p.id] = id;
    }

    // 5) Seed Drives
    const drivesData = [
      { id: "cj-ssd",     name: "CJ Working SSD",        owner: "cj",      location: "Los Angeles", status: "online",  tier: "hot",   model: "OWC Envoy Pro FX 4TB",   capTB: 4,  usedTB: 3.6,  dupTB: 0.42, cleanTB: 0.61, scans: 142 },
      { id: "brandon-arc",name: "Brandon Archive 01",    owner: "brandon", location: "Los Angeles", status: "offline", tier: "cold",  model: "Synology HAT5300 18TB",  capTB: 18, usedTB: 15.2, dupTB: 1.9,  cleanTB: 0.0,  scans: 31 },
      { id: "master-02",  name: "Studio Master Drive 02",owner: "brandon", location: "Los Angeles", status: "online",  tier: "warm",  model: "OWC ThunderBay 8 20TB",  capTB: 20, usedTB: 12.8, dupTB: 0.74, cleanTB: 1.4,  scans: 88 },
      { id: "cj-shuttle", name: "CJ Shuttle SSD 02",     owner: "cj",      location: "Los Angeles", status: "online",  tier: "hot",   model: "Samsung X5 2TB",         capTB: 2,  usedTB: 1.5,  dupTB: 0.18, cleanTB: 0.34, scans: 57 },
      { id: "mara-raid",  name: "Ingest RAID (Mara)",    owner: "mara",    location: "Los Angeles", status: "online",  tier: "hot",   model: "OWC ThunderBay 4 mini",  capTB: 8,  usedTB: 3.1,  dupTB: 0.26, cleanTB: 0.5,  scans: 64 },
      { id: "japan-new",  name: "Japan New Storage 01",  owner: "kenji",   location: "Tokyo",       status: "uninit",  tier: "warm",  model: "LaCie 2big RAID 20TB",   capTB: 20, usedTB: 0,    dupTB: 0,    cleanTB: 0,    scans: 0 },
      { id: "japan-work", name: "Kenji Working SSD",     owner: "kenji",   location: "Tokyo",       status: "online",  tier: "hot",   model: "OWC Envoy Pro FX 4TB",   capTB: 4,  usedTB: 2.9,  dupTB: 0.31, cleanTB: 0.44, scans: 39 },
      { id: "brandon-arc2",name: "Brandon Archive 02",   owner: "brandon", location: "Los Angeles", status: "offline", tier: "cold",  model: "Synology HAT5300 18TB",  capTB: 18, usedTB: 9.4,  dupTB: 0.6,  cleanTB: 0,    scans: 12 },
      { id: "vault-a",    name: "Vault Drive A (offsite)",owner: "founder",location: "Iron Mtn · NV",status: "offline", tier: "cold",  model: "Seagate Exos 16TB",      capTB: 16, usedTB: 7.8,  dupTB: 0,    cleanTB: 0,    scans: 4 },
    ];

    const driveIdMap: Record<string, string> = {};
    for (const d of drivesData) {
      const id = await ctx.db.insert("drives", {
        label: d.name,
        volumeId: d.id + "-vol",
        ownerId: memberIdMap[d.owner] || memberIdMap["founder"],
        capacityBytes: tb(d.capTB),
        freeBytes: tb(d.capTB - d.usedTB),
        usedBytes: tb(d.usedTB),
        filesystem: "APFS",
        mountPath: `/Volumes/${d.name}`,
        location: d.location,
        tier: d.tier,
        status: d.status,
        lastSeenAt: timestamp - (5 * 60 * 1000),
        firstSeenAt: timestamp - (180 * 24 * 60 * 60 * 1000),
        notes: `Model: ${d.model}`,
        dupTB: d.dupTB,
        cleanTB: d.cleanTB,
        scans: d.scans,
      });
      driveIdMap[d.id] = id;
    }

    // 6) Seed Cloud Connections
    const connId = await ctx.db.insert("cloudConnections", {
      provider: "google_drive",
      accountEmail: "studio@driveos.media",
      status: "connected",
      quotaBytesTotal: tb(20),
      quotaBytesUsed: tb(13.4),
      lastSyncAt: timestamp,
      createdAt: timestamp - (60 * 24 * 60 * 60 * 1000),
    });

    // 7) Seed Cloud Files
    const cloudFilesData = [
      { name: "EP214_FINAL_v7.mov", sizeGB: 42, project: "show-x", classification: "EXPORT_FINAL" },
      { name: "Northwind_Launch_60s.mov", sizeGB: 18, project: "client-launch", classification: "EXPORT_FINAL" },
      { name: "Wander_EP03_master.mov", sizeGB: 28, project: "japan-ep", classification: "EXPORT_FINAL" },
      { name: "city_timelapse_4k.mp4", sizeGB: 24, project: "show-x", classification: "STOCK_FOOTAGE" },
      { name: "intro_sting_master.wav", sizeGB: 1.2, project: "show-x", classification: "AUDIO" },
    ];

    for (const cf of cloudFilesData) {
      await ctx.db.insert("cloudFiles", {
        provider: "google_drive",
        providerFileId: "gdrive-" + Math.random().toString(36).substring(7),
        cloudConnectionId: connId,
        name: cf.name,
        path: `/GoogleDrive/${cf.project}/${cf.name}`,
        parentId: "gdrive-root-folder",
        sizeBytes: gb(cf.sizeGB),
        mimeType: cf.name.endsWith(".mov") ? "video/quicktime" : cf.name.endsWith(".mp4") ? "video/mp4" : "audio/wav",
        md5Checksum: "md5-" + Math.random().toString(36).substring(7),
        modifiedTime: timestamp,
        trashed: false,
        projectId: projectIdMap[cf.project],
        classification: cf.classification,
      });
    }

    // 8) Seed Sample Files
    const filesToSeed = [
      { name: "A001_C004.mov", sizeGB: 186, project: "show-x", drive: "cj-ssd", classification: "RAW", path: "/Volumes/CJ Working SSD/Show_X/02_RAW/A_CAM/A001_C004.mov", fullHash: "hash-a001-c004" },
      { name: "A001_C004.mov", sizeGB: 186, project: "show-x-old", drive: "brandon-arc", classification: "RAW", path: "/Volumes/Brandon Archive 01/Show_X_OLD/A001_C004.mov", fullHash: "hash-a001-c004" },
      { name: "city_timelapse_4k.mp4", sizeGB: 24, project: "brand-films", drive: "master-02", classification: "STOCK_FOOTAGE", path: "/Volumes/Studio Master Drive 02/Brand_Films/STOCK/city_timelapse_4k.mp4", fullHash: "hash-city-timelapse" },
      { name: "city_timelapse_4k.mp4", sizeGB: 24, project: "show-x", drive: "cj-ssd", classification: "STOCK_FOOTAGE", path: "/Volumes/CJ Working SSD/Show_X/04_ASSETS/STOCK_FOOTAGE/city_timelapse_4k.mp4", fullHash: "hash-city-timelapse" },
      { name: "city_timelapse_4k.mp4", sizeGB: 24, project: "client-launch", drive: "master-02", classification: "STOCK_FOOTAGE", path: "/Volumes/Studio Master Drive 02/Client_Launch/STOCK/city_timelapse_4k.mp4", fullHash: "hash-city-timelapse" },
      { name: "EP214_FINAL_v7.mov", sizeGB: 42, project: "show-x", drive: "cj-ssd", classification: "EXPORT_FINAL", path: "/Volumes/CJ Working SSD/Show_X/07_EXPORTS/FINAL/EP214_FINAL_v7.mov", fullHash: "hash-ep214-final" },
      { name: "B_ROLL_drone_0042.mp4", sizeGB: 58, project: "japan-ep", drive: "japan-work", classification: "RAW", path: "/Volumes/Kenji Working SSD/Japan_Ep03/02_RAW/DRONE/B_ROLL_drone_0042.mp4", quickHash: "qhash-drone-42" },
      { name: "B_ROLL_drone_0042.mp4", sizeGB: 58, project: "japan-ep", drive: "master-02", classification: "RAW", path: "/Volumes/Studio Master Drive 02/Japan_Ep03/RAW/DRONE/B_ROLL_drone_0042.mp4", quickHash: "qhash-drone-42" },
      { name: "intro_sting_master.wav", sizeGB: 1.2, project: "show-x", drive: "cj-ssd", classification: "AUDIO", path: "/Volumes/CJ Working SSD/Show_X/04_ASSETS/SFX/intro_sting_master.wav", fullHash: "hash-sting" },
      { name: "intro_sting_master.wav", sizeGB: 1.2, project: "brand-films", drive: "master-02", classification: "AUDIO", path: "/Volumes/Studio Master Drive 02/Brand_Films/SFX/intro_sting_master.wav", fullHash: "hash-sting" },
      // cache noise
      { name: "ae_cache_file_001.pek", sizeGB: 15, project: "show-x", drive: "cj-ssd", classification: "CACHE", path: "/Volumes/CJ Working SSD/Show_X/06_RENDERS_CACHE/ae_cache_file_001.pek" },
      { name: "ae_cache_file_002.pek", sizeGB: 20, project: "show-x", drive: "cj-ssd", classification: "CACHE", path: "/Volumes/CJ Working SSD/Show_X/06_RENDERS_CACHE/ae_cache_file_002.pek" },
    ];

    const fileIdMap: Record<string, string> = {};
    for (const f of filesToSeed) {
      const id = await ctx.db.insert("files", {
        projectId: projectIdMap[f.project],
        driveId: driveIdMap[f.drive],
        machineId: "mach-local",
        source: "local",
        path: f.path,
        normalizedPath: f.path.toLowerCase(),
        parentPath: f.path.substring(0, f.path.lastIndexOf("/")),
        name: f.name,
        extension: f.name.split(".").pop() || "",
        sizeBytes: gb(f.sizeGB),
        createdAtFile: timestamp - (10 * 24 * 60 * 60 * 1000),
        modifiedAtFile: timestamp - (2 * 24 * 60 * 60 * 1000),
        lastSeenAt: timestamp,
        fullHash: f.fullHash,
        quickHash: f.quickHash,
        classification: f.classification,
        riskLevel: f.classification === "RAW" || f.classification === "EXPORT_FINAL" ? "red" : f.classification === "CACHE" ? "green" : "yellow",
        storageTier: "hot",
        isGenerated: f.classification === "CACHE" || f.classification === "PROXY",
        isRaw: f.classification === "RAW",
        isFinal: f.classification === "EXPORT_FINAL",
        isProjectFile: f.name.endsWith(".prproj") || f.name.endsWith(".aep"),
      });
      fileIdMap[f.name + "-" + f.drive] = id;
    }

    // 9) Seed Duplicate Clusters
    await ctx.db.insert("duplicateClusters", {
      type: "exact",
      hashKey: "hash-a001-c004",
      fileIds: [fileIdMap["A001_C004.mov-cj-ssd"], fileIdMap["A001_C004.mov-brandon-arc"]],
      projectIds: [projectIdMap["show-x"], projectIdMap["show-x-old"]],
      totalBytes: gb(186 * 2),
      wastedBytes: gb(186),
      fileCount: 2,
      recommendedKeepFileId: fileIdMap["A001_C004.mov-cj-ssd"],
      riskLevel: "red",
      explanation: "Keep working copy on SSD; old Brandon copy is ready to quarantine once archived.",
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await ctx.db.insert("duplicateClusters", {
      type: "stock",
      hashKey: "hash-city-timelapse",
      fileIds: [fileIdMap["city_timelapse_4k.mp4-master-02"], fileIdMap["city_timelapse_4k.mp4-cj-ssd"]],
      projectIds: [projectIdMap["brand-films"], projectIdMap["show-x"]],
      totalBytes: gb(24 * 3),
      wastedBytes: gb(48),
      fileCount: 3,
      recommendedKeepFileId: fileIdMap["city_timelapse_4k.mp4-master-02"],
      riskLevel: "green",
      explanation: "Identical stock video duplicated per project. Centralize to central asset library.",
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // 10) Seed Recommendations
    await ctx.db.insert("recommendations", {
      type: "delete_cache",
      title: "Premiere & DaVinci cache",
      explanation: "Regenerable cache files and render peak buffers. Safe to clear; will auto-rebuild on open. Save 2.4 TB.",
      affectedFileIds: [fileIdMap["ae_cache_file_001.pek-cj-ssd"], fileIdMap["ae_cache_file_002.pek-cj-ssd"]],
      affectedBytes: gb(35),
      riskLevel: "green",
      confidence: 1.0,
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await ctx.db.insert("recommendations", {
      type: "archive_project",
      title: "Archive Client Launch Campaign",
      explanation: "Completed 9 days ago. Move 920 GB to cold Brandon Archive tape catalog.",
      projectId: projectIdMap["client-launch"],
      affectedFileIds: [],
      affectedBytes: gb(920),
      riskLevel: "yellow",
      confidence: 0.95,
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // 11) Seed Audit Logs
    const logEntries = [
      { who: "CJ Marlowe", msg: "Created project Show X — Ep. 214 (YouTube Show template)", act: "project_create", type: "project" },
      { who: "Mara Velez", msg: "Quarantined redundant stock city_timelapse_4k.mp4 from cj-ssd", act: "job_completed", type: "cleanupJob" },
      { who: "DriveOS Agent", msg: "Auto-scan finished for CJ Working SSD (142,308 files indexed)", act: "scan_complete", type: "scanSession" },
      { who: "Brandon Pike", msg: "Approved purge plan for completed client campaign proxies", act: "job_approve", type: "cleanupJob" },
    ];

    for (const le of logEntries) {
      await ctx.db.insert("auditLogs", {
        actorId: le.who,
        action: le.act,
        entityType: le.type,
        message: le.msg,
        createdAt: timestamp - (Math.random() * 12 * 60 * 60 * 1000),
      });
    }

    // 12) Seed Notifications & Alerts from the live derived state
    const seededDrives = await ctx.db.query("drives").collect();
    const seededProjects = await ctx.db.query("projects").collect();
    const seededClusters = await ctx.db.query("duplicateClusters").collect();
    const seededRecs = await ctx.db.query("recommendations").collect();

    const signals = deriveAlerts({
      drives: seededDrives,
      projects: seededProjects,
      duplicateClusters: seededClusters,
      recommendations: seededRecs,
      now: timestamp,
    });

    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      await ctx.db.insert("notifications", {
        key: s.key,
        severity: s.severity,
        category: s.category,
        title: s.title,
        message: s.message,
        entityType: s.entityType,
        entityId: s.entityId,
        actionScreen: s.actionScreen,
        actionParams: s.actionParams,
        metricBytes: s.metricBytes,
        source: "auto",
        read: false,
        dismissed: false,
        // Stagger timestamps so the feed has a natural recent ordering.
        createdAt: timestamp - i * 60 * 1000,
        updatedAt: timestamp - i * 60 * 1000,
        lastSeenAt: timestamp,
      });
    }

    return { success: true, notifications: signals.length };
  },
});
