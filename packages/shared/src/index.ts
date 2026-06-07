// ============================================================
// DriveOS Shared Types & Helpers
// ============================================================

export type Role = "admin" | "producer" | "editor" | "assistant_editor" | "viewer";
export type DriveTier = "hot" | "warm" | "cloud" | "cold" | "unknown";
export type DriveStatus = "online" | "offline" | "uninit" | "cloud";
export type FileRiskLevel = "green" | "yellow" | "red" | "unknown";
export type ProjectStatus = "active" | "review" | "delivered" | "ready_to_archive" | "archived" | "paused";
export type ProjectTier = "hot" | "warm" | "cloud" | "cold";
export type DuplicateType = "exact" | "likely" | "same_name" | "same_size" | "stock_reuse";
export type DuplicateStatus = "open" | "ignored" | "quarantined" | "resolved";
export type RecommendationType =
  | "delete_cache"
  | "delete_proxies"
  | "remove_duplicate"
  | "archive_project"
  | "move_to_warm"
  | "move_to_cold"
  | "copy_to_cloud"
  | "create_missing_folders"
  | "fix_folder_structure"
  | "verify_archive";
export type RecommendationStatus = "open" | "approved" | "ignored" | "completed" | "failed";
export type CleanupAction = "quarantine" | "restore" | "generate_manifest" | "create_folder_structure" | "mark_ignored";
export type CleanupJobStatus = "draft" | "pending_approval" | "approved" | "queued" | "running" | "completed" | "failed" | "cancelled";
export type QuarantineStatus = "quarantined" | "restored" | "permanently_deleted";

// ---- File Classifications ----
export type FileClassification =
  | "RAW"
  | "PROXY"
  | "CACHE"
  | "RENDER_PREVIEW"
  | "PROJECT_FILE"
  | "EXPORT_REVIEW"
  | "EXPORT_FINAL"
  | "STOCK_FOOTAGE"
  | "AUDIO"
  | "MUSIC"
  | "SFX"
  | "GRAPHICS"
  | "FONT"
  | "DOCUMENT"
  | "ADMIN"
  | "ARCHIVE_MANIFEST"
  | "UNKNOWN";

// ---- Core Interfaces (Matches Convex schemas) ----

export interface TeamMember {
  id?: string;
  name: string;
  email: string;
  role: Role;
  avatarUrl?: string;
  location?: string;
  usedTB?: number;
  drives?: number;
  createdAt: number;
}

export interface Machine {
  id?: string;
  name: string;
  ownerId: string;
  agentVersion: string;
  platform: string;
  lastSeenAt: number;
  status: "online" | "offline" | "unknown";
  createdAt: number;
}

export interface Drive {
  id?: string;
  label: string;
  volumeId: string;
  machineId?: string;
  ownerId: string;
  capacityBytes: number;
  freeBytes: number;
  usedBytes: number;
  filesystem?: string;
  mountPath: string;
  location?: string;
  tier: DriveTier;
  status: DriveStatus;
  lastSeenAt: number;
  firstSeenAt: number;
  dupTB?: number;
  cleanTB?: number;
  scans?: number;
  notes?: string;
}

export interface ScanSession {
  id?: string;
  machineId: string;
  driveId?: string;
  rootPath: string;
  startedAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed" | "partial";
  filesScanned: number;
  bytesScanned: number;
  errorsCount: number;
  agentVersion: string;
}

export interface FileRecord {
  id?: string;
  projectId?: string;
  driveId?: string;
  machineId?: string;
  cloudConnectionId?: string;
  cloudFileId?: string;
  source: "local" | "cloud";
  path: string;
  normalizedPath: string;
  parentPath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  createdAtFile: number;
  modifiedAtFile: number;
  lastSeenAt: number;
  deletedAt?: number;
  quickHash?: string;
  fullHash?: string;
  mediaFingerprint?: string;
  classification: FileClassification;
  riskLevel: FileRiskLevel;
  storageTier: DriveTier;
  isGenerated: boolean;
  isRaw: boolean;
  isFinal: boolean;
  isProjectFile: boolean;
  scanSessionId?: string;
  metadata?: Record<string, any>;
}

export interface Project {
  id?: string;
  name: string;
  client: string;
  showName?: string;
  episode?: string;
  slug: string;
  ownerId: string;
  status: ProjectStatus;
  tier: ProjectTier;
  rootPath?: string;
  cloudFolderId?: string;
  folderTemplateId?: string;
  createdAt: number;
  dueDate?: number;
  deliveredAt?: number;
  archivedAt?: number;
  storageHealthScore: number;
  totalBytes: number;
  duplicateBytes: number;
  safeCleanupBytes: number;
  riskyBytes: number;
  notes?: string;
}

export interface FolderTemplate {
  id?: string;
  name: string;
  description: string;
  tree: Array<{ name: string; lvl: number }>;
  rules: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  isDefault: boolean;
}

export interface DuplicateCluster {
  id?: string;
  type: DuplicateType;
  hashKey: string;
  fileIds: string[];
  projectIds: string[];
  totalBytes: number;
  wastedBytes: number;
  fileCount: number;
  recommendedKeepFileId?: string;
  riskLevel: FileRiskLevel;
  explanation: string;
  status: DuplicateStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Recommendation {
  id?: string;
  type: RecommendationType;
  title: string;
  explanation: string;
  projectId?: string;
  driveId?: string;
  affectedFileIds: string[];
  affectedBytes: number;
  riskLevel: FileRiskLevel;
  confidence: number;
  status: RecommendationStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CleanupJob {
  id?: string;
  recommendationId?: string;
  machineId?: string;
  requestedBy: string;
  approvedBy?: string;
  action: CleanupAction;
  status: CleanupJobStatus;
  affectedFileIds: string[];
  affectedBytes: number;
  rollbackUntil?: number;
  result?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface QuarantineItem {
  id?: string;
  cleanupJobId: string;
  originalPath: string;
  quarantinePath: string;
  fileId: string;
  sizeBytes: number;
  movedAt: number;
  rollbackUntil: number;
  status: QuarantineStatus;
  restoredAt?: number;
  deletedAt?: number;
}

export interface CloudConnection {
  id?: string;
  provider: "google_drive";
  accountEmail: string;
  status: "connected" | "disconnected" | "error" | "demo";
  quotaBytesTotal: number;
  quotaBytesUsed: number;
  lastSyncAt: number;
  createdAt: number;
}

export interface CloudFile {
  id?: string;
  provider: "google_drive";
  providerFileId: string;
  cloudConnectionId: string;
  name: string;
  path: string;
  parentId: string;
  sizeBytes: number;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime: number;
  trashed: boolean;
  projectId?: string;
  classification: FileClassification;
  metadata?: Record<string, any>;
}

export interface ArchiveManifest {
  id?: string;
  projectId: string;
  driveId?: string;
  createdBy: string;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
  manifestPath: string;
  checksum: string;
  status: "generated" | "verified" | "failed";
  verificationResult?: Record<string, any>;
}

export interface AuditLog {
  id?: string;
  actorId?: string;
  machineId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  message: string;
  metadata?: Record<string, any>;
  createdAt: number;
}

// ============================================================
// Deterministic Classification Rules
// ============================================================

export function classifyFile(filePath: string, fileName: string): FileClassification {
  const pathUpper = filePath.toUpperCase();
  const nameUpper = fileName.toUpperCase();
  const ext = nameUpper.split(".").pop() || "";

  // 1) PROJECT_FILES
  const projectExtensions = ["PRPROJ", "AEP", "DRP", "FCPXML", "PSD", "AI", "SKETCH", "FIG"];
  if (projectExtensions.includes(ext)) {
    // PSD or AI are only PROJECT_FILE if in a project/design workspace, otherwise classified as GRAPHICS
    if (ext === "PSD" || ext === "AI") {
      if (pathUpper.includes("PROJECT_FILES") || pathUpper.includes("DESIGN") || pathUpper.includes("WORK") || pathUpper.includes("03_PROJECT_FILES")) {
        return "PROJECT_FILE";
      }
      return "GRAPHICS";
    }
    return "PROJECT_FILE";
  }

  // 2) ADMIN & DOCUMENTS
  if (pathUpper.includes("00_ADMIN") || pathUpper.includes("CONTRACTS") || pathUpper.includes("LICENSES") || pathUpper.includes("INVOICES") || pathUpper.includes("LEGAL")) {
    return "ADMIN";
  }

  const docExtensions = ["PDF", "DOCX", "DOC", "XLSX", "XLS", "CSV", "TXT", "PAGES", "KEY", "NUMBERS", "PPTX"];
  if (docExtensions.includes(ext)) {
    return "DOCUMENT";
  }

  // 3) CACHE
  if (
    pathUpper.includes("/CACHE/") ||
    pathUpper.includes("/RENDERS_CACHE/") ||
    pathUpper.includes("/ADOBE/COMMON/MEDIA CACHE/") ||
    pathUpper.includes("/RENDER FILES/") ||
    pathUpper.includes("/DAVINCI_CACHE/") ||
    pathUpper.includes("/AFTER_EFFECTS_CACHE/") ||
    ["PEK", "IMS", "CFA", "PRV", "SND"].includes(ext)
  ) {
    return "CACHE";
  }

  // 4) RENDER PREVIEW
  if (
    pathUpper.includes("/PREMIERE_PREVIEWS/") ||
    pathUpper.includes("/RENDER_PREVIEW/") ||
    pathUpper.includes("/PREVIEW_FILES/")
  ) {
    return "RENDER_PREVIEW";
  }

  // 5) RAW FOOTAGE
  const rawExtensions = ["MXF", "BRAW", "R3D", "ARI", "CRM", "CR2", "NEF", "ARW"];
  const rawVideoContainer = ["MOV", "MP4"];
  if (rawExtensions.includes(ext)) {
    return "RAW";
  }
  if (rawVideoContainer.includes(ext)) {
    if (
      pathUpper.includes("/RAW/") ||
      pathUpper.includes("/CAMERA/") ||
      pathUpper.includes("/02_RAW/") ||
      pathUpper.includes("/A_CAM/") ||
      pathUpper.includes("/B_CAM/") ||
      pathUpper.includes("/C_CAM/") ||
      pathUpper.includes("/DRONE/")
    ) {
      return "RAW";
    }
  }

  // 6) PROXY
  if (
    pathUpper.includes("/PROXIES/") ||
    pathUpper.includes("/05_PROXIES/") ||
    nameUpper.includes("PROXY") ||
    nameUpper.includes("_PRX_") ||
    nameUpper.includes("LOWRES")
  ) {
    return "PROXY";
  }

  // 7) EXPORT FINAL / DELIVERIES
  if (
    pathUpper.includes("/EXPORTS/FINAL/") ||
    pathUpper.includes("/DELIVERY/") ||
    pathUpper.includes("/08_DELIVERY/") ||
    nameUpper.includes("_FINAL") ||
    nameUpper.includes("DELIVERY") ||
    nameUpper.includes("MASTER_CLEAN") ||
    nameUpper.includes("APPROVED_FINAL")
  ) {
    return "EXPORT_FINAL";
  }

  // 8) EXPORT REVIEW
  if (
    pathUpper.includes("/EXPORTS/REVIEW/") ||
    pathUpper.includes("/REVIEW/") ||
    nameUpper.includes("REVIEW") ||
    nameUpper.includes("_V1") ||
    nameUpper.includes("_V2") ||
    nameUpper.includes("_V3") ||
    nameUpper.includes("DRAFT") ||
    nameUpper.includes("CLIENT_CUT")
  ) {
    return "EXPORT_REVIEW";
  }

  // 9) STOCK FOOTAGE
  if (
    pathUpper.includes("/STOCK/") ||
    pathUpper.includes("/STOCK_FOOTAGE/") ||
    pathUpper.includes("/ARTGRID/") ||
    pathUpper.includes("/STORYBLOCKS/") ||
    pathUpper.includes("/ENVATO/") ||
    pathUpper.includes("/SHUTTERSTOCK/")
  ) {
    return "STOCK_FOOTAGE";
  }

  // 10) MUSIC & SFX
  const audioExtensions = ["WAV", "MP3", "AAC", "AIF", "AIFF", "M4A", "FLAC", "OGG"];
  if (audioExtensions.includes(ext)) {
    if (pathUpper.includes("/MUSIC/") || nameUpper.includes("MUSIC_") || pathUpper.includes("EPIDEMIC")) {
      return "MUSIC";
    }
    if (pathUpper.includes("/SFX/") || pathUpper.includes("/SOUND_EFFECTS/") || nameUpper.includes("SFX_")) {
      return "SFX";
    }
    return "AUDIO";
  }

  // 11) GRAPHICS / FONTS / ARCHIVE MANIFEST
  const fontExtensions = ["TTF", "OTF", "WOFF", "WOFF2"];
  if (fontExtensions.includes(ext)) {
    return "FONT";
  }

  const imageExtensions = ["PNG", "JPG", "JPEG", "TIFF", "TGA", "EXR", "SVG", "GIF"];
  if (imageExtensions.includes(ext)) {
    if (pathUpper.includes("/GRAPHICS/") || pathUpper.includes("/04_ASSETS/GRAPHICS/") || pathUpper.includes("/DESIGN/")) {
      return "GRAPHICS";
    }
    return "GRAPHICS";
  }

  if (nameUpper.includes("MANIFEST.JSON") || pathUpper.includes("ARCHIVE_MANIFEST") || pathUpper.includes("project_manifest.json")) {
    return "ARCHIVE_MANIFEST";
  }

  return "UNKNOWN";
}

// ============================================================
// Risk Calculation Rules
// ============================================================

export function calculateFileRisk(classification: FileClassification, sizeBytes: number): FileRiskLevel {
  // RAW footage, Project files, final exports and manifests are always RED
  if (["RAW", "PROJECT_FILE", "EXPORT_FINAL", "ADMIN", "ARCHIVE_MANIFEST"].includes(classification)) {
    return "red";
  }

  // Caches and generated proxies are GREEN/YELLOW
  if (classification === "CACHE" || classification === "RENDER_PREVIEW") {
    return "green";
  }

  if (classification === "PROXY") {
    return sizeBytes > 10 * 1024 * 1024 * 1024 ? "yellow" : "green"; // proxies > 10GB are yellow
  }

  if (classification === "EXPORT_REVIEW" || classification === "STOCK_FOOTAGE") {
    return "yellow";
  }

  // Large unknown files are red, small are yellow
  if (classification === "UNKNOWN") {
    return sizeBytes > 100 * 1024 * 1024 ? "red" : "yellow"; // > 100MB is red
  }

  return "yellow"; // defaults for audio, music, sfx, gfx, docs
}

// ============================================================
// Project Storage Health Score Calculation
// ============================================================

export function calculateProjectHealth(
  structureScore: number, // 0 to 100
  totalBytes: number,
  duplicateBytes: number,
  safeCleanupBytes: number,
  hasFinalExport: boolean,
  hasProjectFiles: boolean,
  hasRawFootage: boolean
): number {
  if (totalBytes === 0) return 100;

  let score = 100;

  // Deduct for poor folder structure completeness (weight: 25%)
  score -= (100 - structureScore) * 0.25;

  // Deduct for waste ratio (duplicateBytes + safeCleanupBytes) / totalBytes (weight: 25%)
  const wasteBytes = duplicateBytes + safeCleanupBytes;
  const wasteRatio = wasteBytes / totalBytes;
  score -= Math.min(25, wasteRatio * 50); // up to 25 point deduction for high waste

  // Deduct for critical components missing (weight: 50% split)
  if (!hasFinalExport) score -= 15;
  if (!hasProjectFiles) score -= 15;
  if (!hasRawFootage) score -= 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ============================================================
// Notifications & Alerts Engine (deterministic, pure)
// ------------------------------------------------------------
// Derives the studio-wide alert feed from the current storage
// state. Kept side-effect free so it can be unit tested and
// reused by the Convex backend, the agent, and the web UI.
// ============================================================

export type AlertSeverity = "critical" | "warning" | "info" | "success";
export type AlertCategory =
  | "drive"
  | "project"
  | "duplicate"
  | "cleanup"
  | "agent"
  | "cloud"
  | "archive"
  | "system";

export interface AlertSignal {
  /** Stable key used to de-duplicate the alert across refreshes. */
  key: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  /** Web route to deep-link to when the alert is clicked. */
  actionScreen?: string;
  actionParams?: Record<string, string>;
  /** Bytes reclaimable / at risk — used for ranking and display. */
  metricBytes?: number;
}

export interface AlertThresholds {
  driveCriticalRatio: number;
  driveWarningRatio: number;
  driveOfflineMs: number;
  duplicateWarnBytes: number;
  cleanupInfoBytes: number;
  agentStaleMs: number;
  projectRiskyBytes: number;
  projectHealthFloor: number;
  projectDueSoonMs: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  driveCriticalRatio: 0.92,
  driveWarningRatio: 0.8,
  driveOfflineMs: 14 * 24 * 60 * 60 * 1000, // 14 days
  duplicateWarnBytes: 1024 ** 4, // 1 TB
  cleanupInfoBytes: 0.5 * 1024 ** 4, // 0.5 TB
  agentStaleMs: 30 * 60 * 1000, // 30 minutes
  projectRiskyBytes: 0.5 * 1024 ** 4, // 0.5 TB single-copy footage
  projectHealthFloor: 60,
  projectDueSoonMs: 3 * 24 * 60 * 60 * 1000, // 3 days
};

export interface AlertInputDrive {
  _id?: string;
  id?: string;
  label?: string;
  name?: string;
  capacityBytes?: number;
  usedBytes?: number;
  freeBytes?: number;
  status?: string;
  tier?: string;
  cleanTB?: number;
  lastSeenAt?: number;
}

export interface AlertInputProject {
  _id?: string;
  id?: string;
  name?: string;
  status?: string;
  tier?: string;
  storageHealthScore?: number;
  riskyBytes?: number;
  totalBytes?: number;
  dueDate?: number;
}

export interface AlertInputCluster {
  status?: string;
  type?: string;
  wastedBytes?: number;
}

export interface AlertInputRecommendation {
  status?: string;
  type?: string;
  riskLevel?: string;
  affectedBytes?: number;
}

export interface AlertInputMachine {
  _id?: string;
  id?: string;
  name?: string;
  status?: string;
  lastSeenAt?: number;
}

export interface DeriveAlertsInput {
  drives?: AlertInputDrive[];
  projects?: AlertInputProject[];
  duplicateClusters?: AlertInputCluster[];
  recommendations?: AlertInputRecommendation[];
  machines?: AlertInputMachine[];
  now?: number;
  thresholds?: Partial<AlertThresholds>;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  success: 3,
};

function fmtBytes(bytes: number): string {
  const tb = bytes / 1024 ** 4;
  if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 1)} TB`;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

function driveKey(d: AlertInputDrive): string {
  return String(d._id || d.id || d.label || d.name || "drive");
}

function projectKey(p: AlertInputProject): string {
  return String(p._id || p.id || p.name || "project");
}

export function deriveAlerts(input: DeriveAlertsInput): AlertSignal[] {
  const now = input.now ?? Date.now();
  const t: AlertThresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...(input.thresholds || {}) };
  const alerts: AlertSignal[] = [];

  // ---- Drives ----
  for (const d of input.drives || []) {
    const id = driveKey(d);
    const name = d.label || d.name || "Drive";
    const status = (d.status || "online").toLowerCase();
    const capacity = d.capacityBytes || 0;
    const used = d.usedBytes ?? (capacity && d.freeBytes != null ? capacity - d.freeBytes : 0);
    const ratio = capacity > 0 ? used / capacity : 0;
    const cleanBytes = (d.cleanTB || 0) * 1024 ** 4;

    if (status === "uninit") {
      alerts.push({
        key: `drive-uninit-${id}`,
        severity: "info",
        category: "drive",
        title: `${name} needs initialization`,
        message: `A new ${fmtBytes(capacity)} volume was detected but is not yet tracked by DriveOS.`,
        entityType: "drive",
        entityId: id,
        actionScreen: "drive",
        actionParams: { id },
      });
      continue;
    }

    if (capacity > 0 && status !== "cloud") {
      if (ratio >= t.driveCriticalRatio) {
        alerts.push({
          key: `drive-full-${id}`,
          severity: "critical",
          category: "drive",
          title: `${name} is ${Math.round(ratio * 100)}% full`,
          message: `Only ${fmtBytes(capacity - used)} free on a working drive.${
            cleanBytes > 0 ? ` Cleanup can recover ${fmtBytes(cleanBytes)}.` : ""
          }`,
          entityType: "drive",
          entityId: id,
          actionScreen: "drive",
          actionParams: { id },
          metricBytes: used,
        });
      } else if (ratio >= t.driveWarningRatio) {
        alerts.push({
          key: `drive-full-${id}`,
          severity: "warning",
          category: "drive",
          title: `${name} is filling up (${Math.round(ratio * 100)}%)`,
          message: `${fmtBytes(capacity - used)} free remaining.${
            cleanBytes > 0 ? ` Cleanup can recover ${fmtBytes(cleanBytes)}.` : ""
          }`,
          entityType: "drive",
          entityId: id,
          actionScreen: "drive",
          actionParams: { id },
          metricBytes: used,
        });
      }
    }

    if (status === "offline" && d.lastSeenAt != null && now - d.lastSeenAt >= t.driveOfflineMs) {
      const days = Math.round((now - d.lastSeenAt) / (24 * 60 * 60 * 1000));
      alerts.push({
        key: `drive-offline-${id}`,
        severity: "info",
        category: "drive",
        title: `${name} has been offline ${days} days`,
        message: `DriveOS has not seen this volume in ${days} days. Re-connect it to refresh its index.`,
        entityType: "drive",
        entityId: id,
        actionScreen: "drive",
        actionParams: { id },
      });
    }
  }

  // ---- Duplicates ----
  const openClusters = (input.duplicateClusters || []).filter((c) => (c.status || "open") === "open");
  const dupWaste = openClusters.reduce((acc, c) => acc + (c.wastedBytes || 0), 0);
  if (dupWaste >= t.duplicateWarnBytes) {
    alerts.push({
      key: "dup-waste",
      severity: "warning",
      category: "duplicate",
      title: `Reclaim ${fmtBytes(dupWaste)} of duplicates`,
      message: `${openClusters.length} open duplicate cluster${
        openClusters.length === 1 ? "" : "s"
      } are wasting ${fmtBytes(dupWaste)} across drives. Review and quarantine the redundant copies.`,
      actionScreen: "duplicates",
      metricBytes: dupWaste,
    });
  }

  // ---- Safe cleanup ----
  const safeRecs = (input.recommendations || []).filter(
    (r) => (r.status || "open") === "open" && (r.riskLevel || "") === "green"
  );
  const safeBytes = safeRecs.reduce((acc, r) => acc + (r.affectedBytes || 0), 0);
  if (safeBytes >= t.cleanupInfoBytes) {
    alerts.push({
      key: "cleanup-safe",
      severity: "success",
      category: "cleanup",
      title: `${fmtBytes(safeBytes)} of safe cleanup ready`,
      message: `${safeRecs.length} low-risk recommendation${
        safeRecs.length === 1 ? "" : "s"
      } can free ${fmtBytes(safeBytes)} of cache, proxies, and duplicates with one approval.`,
      actionScreen: "cleanup",
      metricBytes: safeBytes,
    });
  }

  // ---- Projects ----
  for (const p of input.projects || []) {
    const id = projectKey(p);
    const name = p.name || "Project";
    const status = (p.status || "active").toLowerCase();

    if (status === "ready_to_archive" || status === "ready") {
      alerts.push({
        key: `project-archive-${id}`,
        severity: "info",
        category: "archive",
        title: `${name} is ready to archive`,
        message: `Delivered and verified. Move ${fmtBytes(p.totalBytes || 0)} to cold archive to free working storage.`,
        entityType: "project",
        entityId: id,
        actionScreen: "project",
        actionParams: { id },
        metricBytes: p.totalBytes,
      });
    }

    if ((p.riskyBytes || 0) >= t.projectRiskyBytes) {
      alerts.push({
        key: `project-risk-${id}`,
        severity: "critical",
        category: "project",
        title: `Single-copy risk: ${name}`,
        message: `${fmtBytes(p.riskyBytes || 0)} of footage exists on only one drive with no archive or cloud backup.`,
        entityType: "project",
        entityId: id,
        actionScreen: "project",
        actionParams: { id },
        metricBytes: p.riskyBytes,
      });
    }

    if (
      p.dueDate != null &&
      p.dueDate - now <= t.projectDueSoonMs &&
      p.dueDate - now >= 0 &&
      (status === "active" || status === "review")
    ) {
      const days = Math.max(0, Math.round((p.dueDate - now) / (24 * 60 * 60 * 1000)));
      alerts.push({
        key: `project-due-${id}`,
        severity: "warning",
        category: "project",
        title: `${name} is due ${days <= 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`,
        message: `Delivery deadline is approaching. Confirm exports and backups are in place.`,
        entityType: "project",
        entityId: id,
        actionScreen: "project",
        actionParams: { id },
      });
    }

    if (
      p.storageHealthScore != null &&
      p.storageHealthScore < t.projectHealthFloor &&
      status !== "archived"
    ) {
      alerts.push({
        key: `project-health-${id}`,
        severity: "warning",
        category: "project",
        title: `${name} structure health is ${Math.round(p.storageHealthScore)}%`,
        message: `Folder structure is incomplete or cluttered. Run the structure fix to restore the studio template.`,
        entityType: "project",
        entityId: id,
        actionScreen: "project",
        actionParams: { id },
      });
    }
  }

  // ---- Agents / machines ----
  for (const m of input.machines || []) {
    const id = String(m._id || m.id || m.name || "agent");
    const name = m.name || "Agent";
    const stale = m.lastSeenAt != null && now - m.lastSeenAt >= t.agentStaleMs;
    if ((m.status || "online").toLowerCase() === "offline" || stale) {
      alerts.push({
        key: `agent-offline-${id}`,
        severity: "warning",
        category: "agent",
        title: `Agent ${name} is offline`,
        message: `The local DriveOS agent on ${name} has stopped reporting. Scans and cleanup jobs are paused until it reconnects.`,
        entityType: "machine",
        entityId: id,
        actionScreen: "settings",
      });
    }
  }

  alerts.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return (b.metricBytes || 0) - (a.metricBytes || 0);
  });

  return alerts;
}
