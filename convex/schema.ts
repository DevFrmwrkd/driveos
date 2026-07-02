import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// DriveOS is multi-tenant: every signup creates an isolated `tenant`
// (organization). Each domain row carries a `tenantId` and the dashboard/agent
// only ever read or write rows for the caller's tenant. `tenantId` is optional
// at the schema level so pre-multitenant rows still validate; a one-time
// backfill (tenants.backfillExistingData) stamps them onto a default tenant.
export default defineSchema({
  // Convex Auth tables (users, authAccounts, authSessions, …). We override the
  // built-in `users` table below to link it to our team member + tenant.
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    image: v.optional(v.string()),
    isAnonymous: v.optional(v.boolean()),
    teamMemberId: v.optional(v.string()),
    tenantId: v.optional(v.string()),
  }).index("email", ["email"]),

  // An organization / workspace. One is created per first-time signup.
  tenants: defineTable({
    name: v.string(),
    slug: v.string(),
    plan: v.optional(v.string()), // "free" | "pro" | ...
    ownerUserId: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_slug", ["slug"]),

  teamMembers: defineTable({
    tenantId: v.optional(v.string()),
    name: v.string(),
    email: v.string(),
    role: v.string(), // "admin" | "producer" | "editor" | "assistant_editor" | "viewer"
    avatarUrl: v.optional(v.string()),
    location: v.optional(v.string()),
    usedTB: v.optional(v.number()),
    drives: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_email", ["email"]),

  machines: defineTable({
    tenantId: v.optional(v.string()),
    name: v.string(),
    ownerId: v.string(), // matches teamMember ID or "local-system"
    agentVersion: v.string(),
    platform: v.string(),
    location: v.optional(v.string()), // where this machine physically is; drives inherit it
    lastSeenAt: v.number(),
    status: v.string(), // "online" | "offline" | "unknown"
    authTokenHash: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_tokenHash", ["authTokenHash"]),

  drives: defineTable({
    tenantId: v.optional(v.string()),
    label: v.string(),
    volumeId: v.string(),
    machineId: v.optional(v.string()),
    ownerId: v.string(), // matches teamMember ID
    capacityBytes: v.number(),
    freeBytes: v.number(),
    usedBytes: v.number(),
    filesystem: v.optional(v.string()),
    mountPath: v.string(),
    location: v.optional(v.string()),
    tier: v.string(), // "hot" | "warm" | "cloud" | "cold" | "unknown"
    status: v.string(), // "online" | "offline" | "uninit" | "cloud"
    lastSeenAt: v.number(),
    firstSeenAt: v.number(),
    notes: v.optional(v.string()),
    dupTB: v.optional(v.number()),
    cleanTB: v.optional(v.number()),
    scans: v.optional(v.number()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_volume", ["tenantId", "volumeId"]),

  scanSessions: defineTable({
    tenantId: v.optional(v.string()),
    machineId: v.string(),
    driveId: v.optional(v.string()),
    rootPath: v.string(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    status: v.string(), // "running" | "completed" | "failed" | "partial"
    filesScanned: v.number(),
    bytesScanned: v.number(),
    errorsCount: v.number(),
    agentVersion: v.string(),
  }).index("by_tenant", ["tenantId"]),

  // One row per tenant: gates the expensive post-scan analysis (duplicate
  // detection + recommendations page the ENTIRE catalog). Automatic analysis
  // is kill-switched by default; if explicitly enabled, it only runs when
  // dirtyCount > 0 and at most once per tenant per day.
  analysisState: defineTable({
    tenantId: v.string(),
    dirtyCount: v.number(), // files inserted/materially changed since last run
    scheduled: v.boolean(), // an analysis run is already queued
    lastRunAt: v.number(), // when analysis last STARTED (0 = never)
  }).index("by_tenant", ["tenantId"]),

  files: defineTable({
    tenantId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    driveId: v.optional(v.string()),
    machineId: v.optional(v.string()),
    cloudConnectionId: v.optional(v.string()),
    cloudFileId: v.optional(v.string()),
    source: v.string(), // "local" | "cloud"
    path: v.string(),
    // Legacy denormalized copies of `path` (lowercased / dirname). Never queried
    // anywhere; kept optional so old rows validate, but no longer written —
    // together they roughly doubled per-document path bytes.
    normalizedPath: v.optional(v.string()),
    parentPath: v.optional(v.string()),
    name: v.string(),
    extension: v.string(),
    sizeBytes: v.number(),
    createdAtFile: v.number(),
    modifiedAtFile: v.number(),
    lastSeenAt: v.number(),
    deletedAt: v.optional(v.number()),
    quickHash: v.optional(v.string()),
    fullHash: v.optional(v.string()),
    mediaFingerprint: v.optional(v.string()),
    classification: v.string(), // RAW, PROXY, CACHE, etc.
    riskLevel: v.string(), // "green" | "yellow" | "red" | "unknown"
    storageTier: v.string(), // "hot" | "warm" | "cloud" | "cold" | "unknown"
    isGenerated: v.boolean(),
    isRaw: v.boolean(),
    isFinal: v.boolean(),
    isProjectFile: v.boolean(),
    scanSessionId: v.optional(v.string()),
    metadata: v.optional(v.any()),
  })
    // Keep this index list minimal: `files` is by far the biggest table and
    // every index multiplies its storage and write cost. Only indexes with an
    // actual query site exist — resist adding "might need it" indexes here.
    .index("by_project", ["projectId"])
    .index("by_drive_path", ["driveId", "path"])
    .index("by_tenant", ["tenantId"]),

  projects: defineTable({
    tenantId: v.optional(v.string()),
    name: v.string(),
    client: v.string(),
    showName: v.optional(v.string()),
    episode: v.optional(v.string()),
    slug: v.string(),
    ownerId: v.string(), // matches teamMember ID
    status: v.string(), // "active" | "review" | "delivered" | "ready_to_archive" | "archived" | "paused"
    tier: v.string(), // "hot" | "warm" | "cloud" | "cold"
    rootPath: v.optional(v.string()),
    cloudFolderId: v.optional(v.string()),
    folderTemplateId: v.optional(v.string()),
    createdAt: v.number(),
    dueDate: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
    storageHealthScore: v.number(),
    totalBytes: v.number(),
    duplicateBytes: v.number(),
    safeCleanupBytes: v.number(),
    riskyBytes: v.number(),
    notes: v.optional(v.string()),
    template: v.optional(v.string()), // friendly template name
  })
    .index("by_status", ["status"])
    .index("by_owner", ["ownerId"])
    .index("by_tenant", ["tenantId"]),

  folderTemplates: defineTable({
    tenantId: v.optional(v.string()),
    name: v.string(),
    description: v.string(),
    tree: v.array(v.object({ name: v.string(), lvl: v.number() })),
    rules: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDefault: v.boolean(),
  }).index("by_tenant", ["tenantId"]),

  duplicateClusters: defineTable({
    tenantId: v.optional(v.string()),
    type: v.string(), // "exact" | "likely" | "same_name" | "same_size" | "stock_reuse"
    hashKey: v.string(),
    fileIds: v.array(v.string()),
    projectIds: v.array(v.string()),
    totalBytes: v.number(),
    wastedBytes: v.number(),
    fileCount: v.number(),
    recommendedKeepFileId: v.optional(v.string()),
    riskLevel: v.string(), // "green" | "yellow" | "red" | "unknown"
    explanation: v.string(),
    status: v.string(), // "open" | "ignored" | "quarantined" | "resolved"
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_hashKey", ["hashKey"])
    .index("by_status_wasted", ["status", "wastedBytes"])
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_status_wasted", ["tenantId", "status", "wastedBytes"])
    .index("by_tenant_hashKey", ["tenantId", "hashKey"]),

  recommendations: defineTable({
    tenantId: v.optional(v.string()),
    type: v.string(),
    title: v.string(),
    explanation: v.string(),
    projectId: v.optional(v.string()),
    driveId: v.optional(v.string()),
    affectedFileIds: v.array(v.string()),
    affectedBytes: v.number(),
    riskLevel: v.string(), // "green" | "yellow" | "red" | "unknown"
    confidence: v.number(),
    status: v.string(), // "open" | "approved" | "ignored" | "completed" | "failed"
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_status", ["tenantId", "status"]),

  cleanupJobs: defineTable({
    tenantId: v.optional(v.string()),
    recommendationId: v.optional(v.string()),
    machineId: v.optional(v.string()),
    requestedBy: v.string(), // teamMember ID
    approvedBy: v.optional(v.string()), // teamMember ID
    action: v.string(), // "quarantine" | "restore" | "generate_manifest" | "create_folder_structure" | "mark_ignored"
    status: v.string(), // "draft" | "pending_approval" | "approved" | "queued" | "running" | "completed" | "failed" | "cancelled"
    affectedFileIds: v.array(v.string()),
    affectedBytes: v.number(),
    rollbackUntil: v.optional(v.number()),
    result: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_status", ["tenantId", "status"]),

  quarantineItems: defineTable({
    tenantId: v.optional(v.string()),
    cleanupJobId: v.string(),
    originalPath: v.string(),
    quarantinePath: v.string(),
    fileId: v.string(), // links to files table ID
    sizeBytes: v.number(),
    movedAt: v.number(),
    rollbackUntil: v.number(),
    status: v.string(), // "quarantined" | "restored" | "permanently_deleted"
    restoredAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_tenant", ["tenantId"]),

  cloudConnections: defineTable({
    tenantId: v.optional(v.string()),
    provider: v.string(), // "google_drive"
    accountEmail: v.string(),
    status: v.string(), // "connected" | "disconnected" | "error" | "demo"
    quotaBytesTotal: v.number(),
    quotaBytesUsed: v.number(),
    lastSyncAt: v.number(),
    createdAt: v.number(),
  }).index("by_tenant", ["tenantId"]),

  cloudFiles: defineTable({
    tenantId: v.optional(v.string()),
    provider: v.string(),
    providerFileId: v.string(),
    cloudConnectionId: v.string(),
    name: v.string(),
    path: v.string(),
    parentId: v.string(),
    sizeBytes: v.number(),
    mimeType: v.string(),
    md5Checksum: v.optional(v.string()),
    modifiedTime: v.number(),
    trashed: v.boolean(),
    projectId: v.optional(v.string()),
    classification: v.string(),
    metadata: v.optional(v.any()),
  })
    .index("by_providerFileId", ["providerFileId"])
    .index("by_project", ["projectId"])
    .index("by_tenant", ["tenantId"]),

  archiveManifests: defineTable({
    tenantId: v.optional(v.string()),
    projectId: v.string(),
    driveId: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.number(),
    fileCount: v.number(),
    totalBytes: v.number(),
    manifestPath: v.string(),
    checksum: v.string(),
    status: v.string(), // "generated" | "verified" | "failed"
    verificationResult: v.optional(v.any()),
  }).index("by_tenant", ["tenantId"]),

  auditLogs: defineTable({
    tenantId: v.optional(v.string()),
    actorId: v.optional(v.string()),
    machineId: v.optional(v.string()),
    action: v.string(),
    entityType: v.string(),
    entityId: v.optional(v.string()),
    message: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_tenant_createdAt", ["tenantId", "createdAt"]),
});
