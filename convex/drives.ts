import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember, inTenant } from "./access";

// Max file rows deleted per transaction when removing a drive's catalog. Convex
// caps reads/writes per mutation (~a few thousand); a drive can hold millions of
// files, so deletion is paged and self-reschedules until the catalog is empty.
const DRIVE_FILE_DELETE_BATCH = 500;

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
  label: string
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
  });
}

// Delete one page of a removed drive's file rows, then reschedule itself until
// none remain. Each run stays well under the per-mutation write limit.
export const purgeDriveFiles = internalMutation({
  args: { driveId: v.string(), deleted: v.number() },
  handler: async (ctx, args) => {
    const driveId = ctx.db.normalizeId("drives", args.driveId);
    if (!driveId) return; // malformed id; nothing to do
    const page = await ctx.db
      .query("files")
      .withIndex("by_drive_path", (q) => q.eq("driveId", driveId))
      .take(DRIVE_FILE_DELETE_BATCH);

    for (const f of page) await ctx.db.delete(f._id);

    if (page.length === DRIVE_FILE_DELETE_BATCH) {
      // More rows remain — continue in the next transaction.
      await ctx.scheduler.runAfter(0, internal.drives.purgeDriveFiles, {
        driveId: args.driveId,
        deleted: args.deleted + page.length,
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

    await deleteDriveCatalog(ctx, driveId, tenantId, email, drive.label);
    return { removed: true };
  },
});

// Stop tracking a drive from the agent, matched by volumeId within the agent's
// tenant. Internal-only: reached solely through the token-authenticated HTTP
// route, which injects the verified machine's tenantId. Idempotent.
export const removeByVolumeId = internalMutation({
  args: { volumeId: v.string(), machineId: v.optional(v.string()), tenantId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
    const drive = await ctx.db
      .query("drives")
      .withIndex("by_tenant_volume", (q) =>
        q.eq("tenantId", tenantId).eq("volumeId", args.volumeId)
      )
      .first();
    if (!drive) return { removed: false };

    await deleteDriveCatalog(ctx, drive._id, tenantId, args.machineId, drive.label);
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
    const existing = await ctx.db
      .query("drives")
      .withIndex("by_tenant_volume", (q) =>
        q.eq("tenantId", tenantId).eq("volumeId", args.volumeId)
      )
      .first();

    const timestamp = Date.now();

    // A drive's location is the location of the machine it's plugged into. Fall
    // back to that (not a hardcoded city) when the agent doesn't send one.
    let machineLocation: string | undefined;
    if (args.machineId) {
      const machineIdObj = ctx.db.normalizeId("machines", args.machineId);
      const machine = machineIdObj ? await ctx.db.get(machineIdObj) : null;
      if (machine && machine.tenantId === tenantId) machineLocation = machine.location ?? undefined;
    }
    const resolvedLocation = args.location || machineLocation;

    if (existing) {
      // One indexed read tells an upgrading agent whether it can trust its
      // existing local hash cache as the delta baseline. Without this signal,
      // agent 1.1 would re-send every row once just to establish uploadedFp —
      // more than 10 million records in the current production catalog.
      const catalogFile = await ctx.db
        .query("files")
        .withIndex("by_drive_path", (q) => q.eq("driveId", existing._id))
        .first();

      await ctx.db.patch(existing._id, {
        label: args.label,
        machineId: args.machineId,
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
        machineId: args.machineId,
        action: "drive_update",
        entityType: "drive",
        entityId: existing._id,
        message: `Updated drive ${args.label} (${(args.capacityBytes / (1024 ** 4)).toFixed(1)} TB)`,
        createdAt: timestamp,
      });

      // isNew tells the agent whether the backend already holds a catalog for
      // this volume. A fresh row means any local "already uploaded" markers
      // are stale (drive was forgotten/removed) and must be ignored.
      return { driveId: existing._id, isNew: false, hasCatalog: Boolean(catalogFile) };
    } else {
      const driveId = await ctx.db.insert("drives", {
        tenantId,
        label: args.label,
        volumeId: args.volumeId,
        machineId: args.machineId,
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
        machineId: args.machineId,
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
    name: v.string(),
    ownerId: v.string(),
    agentVersion: v.string(),
    platform: v.string(),
    location: v.optional(v.string()),
    tenantId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenantId = args.tenantId || "";
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
