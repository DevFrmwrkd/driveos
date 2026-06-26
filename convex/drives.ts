import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireMember, inTenant } from "./access";

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

// Shared catalog removal: drop the drive and its file records. Used by both the
// web "Stop tracking" button and the agent's forget-drive command. Only affects
// DriveOS's catalog — never touches the actual disk.
async function deleteDriveCatalog(
  ctx: any,
  driveId: any,
  tenantId: string,
  actorId: string | undefined,
  label: string
) {
  const files = await ctx.db
    .query("files")
    .withIndex("by_drive", (q: any) => q.eq("driveId", driveId))
    .collect();
  for (const f of files) await ctx.db.delete(f._id);

  await ctx.db.delete(driveId);

  await ctx.db.insert("auditLogs", {
    tenantId,
    actorId,
    action: "drive_remove",
    entityType: "drive",
    entityId: driveId,
    message: `Stopped tracking drive "${label}" and removed ${files.length} file record(s).`,
    createdAt: Date.now(),
  });

  return files.length;
}

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

    const filesRemoved = await deleteDriveCatalog(ctx, driveId, tenantId, email, drive.label);
    return { removed: true, filesRemoved };
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

    const filesRemoved = await deleteDriveCatalog(ctx, drive._id, tenantId, args.machineId, drive.label);
    return { removed: true, filesRemoved };
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

      return existing._id;
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

      return driveId;
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
