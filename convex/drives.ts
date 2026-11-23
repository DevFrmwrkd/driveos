import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember, requireRole, inTenant } from "./access";
import { insertApprovedJob } from "./jobUtils";

// Max file rows deleted per transaction when removing a drive's catalog. Convex
// caps reads/writes per mutation (~a few thousand); a drive can hold millions of
// files, so deletion is paged and self-reschedules until the catalog is empty.
const DRIVE_FILE_DELETE_BATCH = 500;
const DRIVE_IDENTITY_VERSION = 1;

async function authenticatedMachine(ctx: any, tenantId: string, machineId: string | undefined) {
  const id = machineId ? ctx.db.normalizeId("machines", machineId) : null;
  const machine = id ? await ctx.db.get(id) : null;
  if (!tenantId || !machine || machine.tenantId !== tenantId) throw new ConvexError("Unknown authenticated machine.");
  return machine;
}

async function driveIdentity(ctx: any, tenantId: string, machineId: string | undefined, volumeId: string, identityVersion: number | undefined) {
  return await ctx.db.query("drives").withIndex("by_tenant_machine_volume_identity", (q: any) =>
    q.eq("tenantId", tenantId).eq("machineId", machineId).eq("volumeId", volumeId).eq("identityVersion", identityVersion)).first();
}

// Check both sides of each ownership key with indexed point/range reads. A
// sample of the first file cannot prove a legacy multi-million-row catalog safe.
async function catalogOwnership(ctx: any, driveId: any, tenantId: string, machineId: string) {
  for (const operator of ["lt", "gt"]) {
    const foreignTenant = await ctx.db.query("files").withIndex("by_drive_catalog_owner", (q: any) =>
      q.eq("driveId", driveId)[operator]("tenantId", tenantId)).first();
    if (foreignTenant) return { safe: false, hasCatalog: true };
    const foreignMachine = await ctx.db.query("files").withIndex("by_drive_catalog_owner", (q: any) =>
      q.eq("driveId", driveId).eq("tenantId", tenantId)[operator]("machineId", machineId)).first();
    if (foreignMachine) return { safe: false, hasCatalog: true };
  }
  const own = await ctx.db.query("files").withIndex("by_drive_catalog_owner", (q: any) =>
    q.eq("driveId", driveId).eq("tenantId", tenantId).eq("machineId", machineId)).first();
  return { safe: true, hasCatalog: Boolean(own) };
}

async function ownedDrive(ctx: any, tenantId: string, machineId: string, volumeId: string, allowEmptyUnassigned: boolean) {
  const canonical = await driveIdentity(ctx, tenantId, machineId, volumeId, DRIVE_IDENTITY_VERSION);
  if (canonical) {
    const ownership = await catalogOwnership(ctx, canonical._id, tenantId, machineId);
    return { drive: ownership.safe ? canonical : null, ...ownership, canonicalConflict: !ownership.safe };
  }
  const candidates = [
    await driveIdentity(ctx, tenantId, machineId, volumeId, undefined),
    await driveIdentity(ctx, tenantId, undefined, volumeId, undefined),
  ];
  let ambiguous = false;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ownership = await catalogOwnership(ctx, candidate._id, tenantId, machineId);
    if (ownership.safe && (candidate.machineId || ownership.hasCatalog || allowEmptyUnassigned))
      return { drive: candidate, ...ownership, canonicalConflict: false };
    ambiguous = true;
  }
  return { drive: null, safe: !ambiguous, hasCatalog: false, canonicalConflict: false };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("drives")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
  },
});

export const requestScan = mutation({
  args: { driveId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const member = await requireRole(ctx, ["admin", "producer", "editor", "assistant_editor"]);
    const all = await ctx.db.query("drives").withIndex("by_tenant", q => q.eq("tenantId", member.tenantId)).collect();
    const drives = args.driveId ? all.filter(d => String(d._id) === args.driveId) : all;
    if (args.driveId && !drives.length) throw new ConvexError("Unknown drive.");
    const active = await ctx.db.query("cleanupJobs").withIndex("by_tenant", q => q.eq("tenantId", member.tenantId)).order("desc").take(200);
    const jobIds = [];
    for (const drive of drives) {
      if (!drive.machineId || drive.tier === "cloud") continue;
      const mid = ctx.db.normalizeId("machines", drive.machineId);
      const machine = mid ? inTenant(await ctx.db.get(mid), member.tenantId) : null;
      if (!machine) continue;
      const existing = active.find(j => j.action === "scan" && j.result?.driveId === String(drive._id) && ["approved", "queued", "running"].includes(j.status));
      if (existing) continue;
      jobIds.push(await insertApprovedJob(ctx, {
        tenantId: member.tenantId, machineId: String(machine._id), requestedBy: member.email,
        action: "scan", result: { rootPath: drive.mountPath, driveId: String(drive._id), analyzeAfterScan: true },
      }));
    }
    if (!jobIds.length && !active.some(j => j.action === "scan" && ["approved", "queued", "running"].includes(j.status)))
      throw new ConvexError("No connected local drive can receive a scan. Add a drive in the local agent first.");
    return { queued: jobIds.length, jobIds };
  },
});

// Shared catalog removal: drop the drive row now, then delete its file records
// in the background in bounded pages. Used by both the web "Stop tracking"
// button and the agent's forget-drive command. Only affects DriveOS's catalog —
// never touches the actual disk. Returns immediately; a drive with millions of
// files would otherwise blow the per-mutation limit in one shot.
async function deleteDriveCatalog(
  ctx: any,
  driveId: any,
  tenantId: string,
  actorId: string | undefined,
  label: string,
  machineId?: string
) {
  // Delete the drive row first so it disappears from the dashboard at once.
  await ctx.db.delete(driveId);

  await ctx.db.insert("auditLogs", {
    tenantId,
    actorId,
    action: "drive_remove",
    entityType: "drive",
    entityId: driveId,
    message: `Stopped tracking drive "${label}". Removing its file records in the background.`,
    createdAt: Date.now(),
  });

  // Kick off paged file deletion (bounded per transaction, self-reschedules).
  await ctx.scheduler.runAfter(0, internal.drives.purgeDriveFiles, {
    driveId: String(driveId),
    deleted: 0,
    tenantId,
    ...(machineId ? { machineId } : {}),
  });
}

// Delete one page of a removed drive's file rows, then reschedule itself until
// none remain. Each run stays well under the per-mutation write limit.
export const purgeDriveFiles = internalMutation({
  args: { driveId: v.string(), deleted: v.number(), tenantId: v.optional(v.string()), machineId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const driveId = ctx.db.normalizeId("drives", args.driveId);
    if (!driveId) return; // malformed id; nothing to do
    // Existing scheduled removals predate the scope arguments. New removals
    // always retain tenant/machine ownership through every bounded page.
    const owned = args.tenantId !== undefined
      ? ctx.db.query("files").withIndex("by_drive_catalog_owner", q => {
        const prefix = q.eq("driveId", driveId).eq("tenantId", args.tenantId);
        return args.machineId !== undefined ? prefix.eq("machineId", args.machineId) : prefix;
      })
      : ctx.db.query("files").withIndex("by_drive_path", q => q.eq("driveId", driveId));
    const page = await owned.take(DRIVE_FILE_DELETE_BATCH);

    for (const f of page) await ctx.db.delete(f._id);

    if (page.length === DRIVE_FILE_DELETE_BATCH) {
      // More rows remain — continue in the next transaction.
      await ctx.scheduler.runAfter(0, internal.drives.purgeDriveFiles, {
        driveId: args.driveId,
        deleted: args.deleted + page.length,
        ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
        ...(args.machineId !== undefined ? { machineId: args.machineId } : {}),
      });
    }
  },
});

// Stop tracking a drive from the web dashboard. Requires a signed-in team member
// and the drive must belong to their workspace.
export const remove = mutation({
  args: { driveId: v.string() },
  handler: async (ctx, args) => {
    const { tenantId, email } = await requireMember(ctx);
    const driveId = ctx.db.normalizeId("drives", args.driveId);
    if (!driveId) return { removed: false };

    const drive = inTenant(await ctx.db.get(driveId), tenantId);
    if (!drive) return { removed: false };

    // A dashboard user selected this exact drive ID, including any legacy
    // catalog with mixed machine ownership. Remove its tenant's whole catalog.
    await deleteDriveCatalog(ctx, driveId, tenantId, email, drive.label);
    return { removed: true };
  },
});

// Agent removal uses the same canonical token-machine identity as registration.
export const removeByVolumeId = internalMutation({
  args: { volumeId: v.string(), machineId: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const machine = await authenticatedMachine(ctx, tenantId, args.machineId);
    const selected = await ownedDrive(ctx, tenantId, String(machine._id), args.volumeId, false);
    const drive = selected.drive;
    if (!drive) return { removed: false, ...(selected.safe ? {} : { reason: "legacy_catalog_ownership_conflict" }) };

    await deleteDriveCatalog(ctx, drive._id, tenantId, String(machine._id), drive.label, String(machine._id));
    return { removed: true };
  },
});

export const get = query({
  args: { driveId: v.string() },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const id = ctx.db.normalizeId("drives", args.driveId);
    if (!id) return null;
    return inTenant(await ctx.db.get(id), tenantId);
  },
});

// Agent-only (internal): register/update a drive in the authenticated tenant.
export const register = internalMutation({
  args: {
    label: v.string(),
    volumeId: v.string(),
    machineId: v.optional(v.string()),
    ownerId: v.string(),
    capacityBytes: v.number(),
    freeBytes: v.number(),
    usedBytes: v.number(),
    filesystem: v.optional(v.string()),
    mountPath: v.string(),
    location: v.optional(v.string()),
    tier: v.string(), // "hot" | "warm" | "cloud" | "cold" | "unknown"
    tenantId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const machine = await authenticatedMachine(ctx, tenantId, args.machineId);
    const machineId = String(machine._id);
    const selected = await ownedDrive(ctx, tenantId, machineId, args.volumeId, true);
    if (selected.canonicalConflict) throw new ConvexError("Drive catalog ownership conflict. Ask an administrator to review this drive.");
    const existing = selected.drive;

    const timestamp = Date.now();

    // A drive's location is the location of the machine it's plugged into. Fall
    // back to that (not a hardcoded city) when the agent doesn't send one.
    const resolvedLocation = args.location || machine.location;

    if (existing) {
      await ctx.db.patch(existing._id, {
        label: args.label,
        machineId,
        identityVersion: DRIVE_IDENTITY_VERSION,
        ownerId: args.ownerId,
        capacityBytes: args.capacityBytes,
        freeBytes: args.freeBytes,
        usedBytes: args.usedBytes,
        filesystem: args.filesystem,
        mountPath: args.mountPath,
        location: resolvedLocation || existing.location,
        tier: args.tier,
        status: "online",
        lastSeenAt: timestamp,
      });

      await ctx.db.insert("auditLogs", {
        tenantId,
        actorId: args.ownerId,
        machineId,
        action: "drive_update",
        entityType: "drive",
        entityId: existing._id,
        message: `Updated drive ${args.label} (${(args.capacityBytes / (1024 ** 4)).toFixed(1)} TB)`,
        createdAt: timestamp,
      });

      // Preserve a clean legacy catalog's ID and hash-cache baseline. An empty
      // catalog needs replay even when a legacy drive row already existed.
      return { driveId: existing._id, isNew: !selected.hasCatalog, hasCatalog: selected.hasCatalog };
    } else {
      const driveId = await ctx.db.insert("drives", {
        tenantId,
        label: args.label,
        volumeId: args.volumeId,
        machineId,
        identityVersion: DRIVE_IDENTITY_VERSION,
        ownerId: args.ownerId,
        capacityBytes: args.capacityBytes,
        freeBytes: args.freeBytes,
        usedBytes: args.usedBytes,
        filesystem: args.filesystem,
        mountPath: args.mountPath,
        location: resolvedLocation,
        tier: args.tier,
        status: "online",
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        scans: 1,
      });

      await ctx.db.insert("auditLogs", {
        tenantId,
        actorId: args.ownerId,
        machineId,
        action: "drive_register",
        entityType: "drive",
        entityId: driveId,
        message: `Registered new drive ${args.label} (${(args.capacityBytes / (1024 ** 4)).toFixed(1)} TB)`,
        createdAt: timestamp,
      });

      return { driveId, isNew: true, hasCatalog: false };
    }
  },
});

export const updateStatus = mutation({
  args: {
    driveId: v.string(),
    status: v.string(), // "online" | "offline"
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireMember(ctx);
    const driveId = ctx.db.normalizeId("drives", args.driveId);
    if (!driveId) return;
    const drive = inTenant(await ctx.db.get(driveId), tenantId);
    if (!drive) return;
    await ctx.db.patch(driveId, {
      status: args.status,
      lastSeenAt: Date.now(),
    });
  },
});

export const listMachines = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireMember(ctx);
    return await ctx.db
      .query("machines")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
  },
});

// Agent-only (internal): register/update the calling machine in its tenant.
export const registerMachine = internalMutation({
  args: {
    machineId: v.optional(v.string()),
    name: v.string(),
    ownerId: v.string(),
    agentVersion: v.string(),
    platform: v.string(),
    location: v.optional(v.string()),
    tenantId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    if (args.machineId !== undefined) {
      // Agent HTTP requests are bound to the issued token, never to a local
      // label that may differ from the name chosen in workspace settings.
      const machine = await authenticatedMachine(ctx, tenantId, args.machineId);
      await ctx.db.patch(machine._id, {
        agentVersion: args.agentVersion,
        platform: args.platform,
        location: machine.location || args.location,
        lastSeenAt: Date.now(),
        status: "online",
      });
      return machine._id;
    }
    const tenantMachines = await ctx.db
      .query("machines")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();
    const existing = tenantMachines.find((m) => m.name === args.name);

    const timestamp = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        agentVersion: args.agentVersion,
        platform: args.platform,
        // Keep a location the user set; only fill it from the agent if unset.
        location: existing.location || args.location,
        lastSeenAt: timestamp,
        status: "online",
      });
      return existing._id;
    } else {
      const machineId = await ctx.db.insert("machines", {
        tenantId,
        name: args.name,
        ownerId: args.ownerId,
        agentVersion: args.agentVersion,
        platform: args.platform,
        location: args.location,
        lastSeenAt: timestamp,
        status: "online",
        createdAt: timestamp,
      });
      return machineId;
    }
  },
});
