import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./access";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("drives").collect();
  },
});

// Shared catalog removal: drop the drive and its file records. Used by both the
// web "Stop tracking" button and the agent's forget-drive command. Only affects
// DriveOS's catalog — never touches the actual disk.
async function deleteDriveCatalog(ctx: any, driveId: any, actorId: string | undefined, label: string) {
  const files = await ctx.db
    .query("files")
    .withIndex("by_drive", (q: any) => q.eq("driveId", driveId))
    .collect();
  for (const f of files) await ctx.db.delete(f._id);

  await ctx.db.delete(driveId);

  await ctx.db.insert("auditLogs", {
    actorId,
    action: "drive_remove",
    entityType: "drive",
    entityId: driveId,
    message: `Stopped tracking drive "${label}" and removed ${files.length} file record(s).`,
    createdAt: Date.now(),
  });

  return files.length;
}

// Stop tracking a drive from the web dashboard. Requires a signed-in team member.
export const remove = mutation({
  args: { driveId: v.string() },
  handler: async (ctx, args) => {
    const member = await requireMember(ctx);
    const driveId = ctx.db.normalizeId("drives", args.driveId);
    if (!driveId) return { removed: false };

    const drive = await ctx.db.get(driveId);
    if (!drive) return { removed: false };

    const filesRemoved = await deleteDriveCatalog(ctx, driveId, member.email, drive.label);
    return { removed: true, filesRemoved };
  },
});

// Stop tracking a drive from the agent, matched by volumeId (how registerDrive
// keys drives). Auth is enforced at the HTTP layer via the machine token, so no
// requireMember here. Idempotent: a drive already gone returns removed:false.
export const removeByVolumeId = mutation({
  args: { volumeId: v.string(), machineId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const drive = await ctx.db
      .query("drives")
      .filter((q) => q.eq(q.field("volumeId"), args.volumeId))
      .first();
    if (!drive) return { removed: false };

    const filesRemoved = await deleteDriveCatalog(ctx, drive._id, args.machineId, drive.label);
    return { removed: true, filesRemoved };
  },
});

export const get = query({
  args: { driveId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("drives", args.driveId);
    if (!id) return null;
    return await ctx.db.get(id);
  },
});

export const register = mutation({
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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("drives")
      .filter((q) => q.eq(q.field("volumeId"), args.volumeId))
      .first();

    const timestamp = Date.now();

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
        location: args.location || existing.location,
        tier: args.tier,
        status: "online",
        lastSeenAt: timestamp,
      });

      await ctx.db.insert("auditLogs", {
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
        label: args.label,
        volumeId: args.volumeId,
        machineId: args.machineId,
        ownerId: args.ownerId,
        capacityBytes: args.capacityBytes,
        freeBytes: args.freeBytes,
        usedBytes: args.usedBytes,
        filesystem: args.filesystem,
        mountPath: args.mountPath,
        location: args.location || "Los Angeles",
        tier: args.tier,
        status: "online",
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        scans: 1,
      });

      await ctx.db.insert("auditLogs", {
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
    const driveId = ctx.db.normalizeId("drives", args.driveId);
    if (!driveId) return;
    await ctx.db.patch(driveId, {
      status: args.status,
      lastSeenAt: Date.now(),
    });
  },
});

export const listMachines = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("machines").collect();
  },
});

export const registerMachine = mutation({
  args: {
    name: v.string(),
    ownerId: v.string(),
    agentVersion: v.string(),
    platform: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("machines")
      .filter((q) => q.eq(q.field("name"), args.name))
      .first();

    const timestamp = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        agentVersion: args.agentVersion,
        platform: args.platform,
        lastSeenAt: timestamp,
        status: "online",
      });
      return existing._id;
    } else {
      const machineId = await ctx.db.insert("machines", {
        name: args.name,
        ownerId: args.ownerId,
        agentVersion: args.agentVersion,
        platform: args.platform,
        lastSeenAt: timestamp,
        status: "online",
        createdAt: timestamp,
      });
      return machineId;
    }
  },
});
