import { ConvexError } from "convex/values";
import { classifyFile } from "../packages/shared/src/index";

export const PROTECTED_CLASSES = new Set(["RAW", "EXPORT_FINAL", "PROJECT_FILE", "ADMIN", "ARCHIVE_MANIFEST"]);
export const CLEANUP_RECOMMENDATION_TYPES = new Set(["delete_cache", "delete_proxies", "remove_duplicate"]);

export function protectedFile(file: any) {
  return file.isRaw || file.isFinal || file.isProjectFile || file.riskLevel === "red" ||
    PROTECTED_CLASSES.has(file.classification) || PROTECTED_CLASSES.has(classifyFile(file.path, file.name));
}

export async function fileMachine(ctx: any, file: any, tenantId: string): Promise<string> {
  let machineId = file.machineId;
  if (!machineId && file.driveId) {
    const driveId = ctx.db.normalizeId("drives", file.driveId);
    const drive = driveId ? await ctx.db.get(driveId) : null;
    if (drive?.tenantId === tenantId) machineId = drive.machineId;
  }
  if (machineId) {
    const id = ctx.db.normalizeId("machines", machineId);
    const machine = id ? await ctx.db.get(id) : null;
    if (machine?.tenantId === tenantId) return String(machine._id);
  }
  throw new ConvexError("This file has no linked machine. Reconnect and scan its drive before requesting a file operation.");
}

export async function quarantineMachine(ctx: any, item: any, tenantId: string) {
  if (item.machineId) return item.machineId as string;
  const fileId = ctx.db.normalizeId("files", item.fileId);
  const file = fileId ? await ctx.db.get(fileId) : null;
  if (!file || file.tenantId !== tenantId) throw new ConvexError("The original file's machine is no longer available.");
  return fileMachine(ctx, file, tenantId);
}

export async function insertApprovedJob(ctx: any, input: {
  tenantId: string; machineId: string; requestedBy: string; action: string;
  fileIds?: string[]; bytes?: number; result?: any; recommendationId?: string;
  rollbackUntil?: number; purgeAfter?: boolean;
}) {
  const now = Date.now();
  const jobId = await ctx.db.insert("cleanupJobs", {
    tenantId: input.tenantId, machineId: input.machineId, requestedBy: input.requestedBy,
    approvedBy: input.requestedBy, action: input.action, status: "approved",
    leaseRequired: true,
    affectedFileIds: input.fileIds ?? [], affectedBytes: input.bytes ?? 0,
    result: input.result, recommendationId: input.recommendationId,
    rollbackUntil: input.rollbackUntil, purgeAfter: input.purgeAfter,
    createdAt: now, updatedAt: now,
  });
  await ctx.db.insert("auditLogs", {
    tenantId: input.tenantId, machineId: input.machineId, actorId: input.requestedBy,
    action: "job_approve", entityType: "cleanupJob", entityId: jobId,
    message: `Queued ${input.action} for ${input.fileIds?.length ?? 0} file(s).`, createdAt: now,
  });
  return jobId;
}
