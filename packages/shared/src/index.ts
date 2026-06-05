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
