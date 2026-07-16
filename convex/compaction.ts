import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// One-shot storage compaction for the `files` table. The ingest side already
// refuses new sub-1MB generic rows and stopped writing the legacy denormalized
// path fields, but the rows created BEFORE those guards landed still sit in
// the database and are what has storage pinned at the plan limit.
//
// This is deliberately a manually-triggered action, NOT a cron: a full-table
// sweep reads every document, so running it repeatedly would itself burn read
// bandwidth. Kick it off once per deployment with
//
//   npx convex run compaction:run '{}'            (dev)
//   npx convex run compaction:run '{}' --prod     (production)
//
// It pages through `files` in _creationTime order, deletes rows the current
// ingest policy would reject, strips legacy fields from the rest, and
// self-reschedules until the whole table has been swept.

const MIN_GENERIC_CATALOG_FILE_SIZE_BYTES = 1024 * 1024; // mirror files.uploadBatch
const BATCH_SIZE = 500;
// Batches per action invocation; the action reschedules itself afterwards so
// one invocation never brushes against the action time limit.
const BATCHES_PER_RUN = 100;

export const compactBatch = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("files")
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });

    let deleted = 0;
    let compacted = 0;
    for (const f of page.page) {
      // Rows the current ingest policy would never have created: cache crumbs,
      // sidecars, thumbnails. Project files stay regardless of size.
      if (f.sizeBytes < MIN_GENERIC_CATALOG_FILE_SIZE_BYTES && !f.isProjectFile) {
        await ctx.db.delete(f._id);
        deleted++;
        continue;
      }
      // Legacy denormalized copies of `path` (plus the never-queried
      // scanSessionId). Setting optional fields to undefined removes them,
      // roughly halving per-document path bytes on old rows.
      if (
        f.normalizedPath !== undefined ||
        f.parentPath !== undefined ||
        f.scanSessionId !== undefined
      ) {
        await ctx.db.patch(f._id, {
          normalizedPath: undefined,
          parentPath: undefined,
          scanSessionId: undefined,
        });
        compacted++;
      }
    }

    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      deleted,
      compacted,
      scanned: page.page.length,
    };
  },
});

export const run = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    totals: v.optional(
      v.object({ deleted: v.number(), compacted: v.number(), scanned: v.number() })
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    let cursor: string | null = args.cursor ?? null;
    const totals = args.totals ?? { deleted: 0, compacted: 0, scanned: 0 };

    for (let i = 0; i < BATCHES_PER_RUN; i++) {
      const result = await ctx.runMutation(internal.compaction.compactBatch, { cursor });
      totals.deleted += result.deleted;
      totals.compacted += result.compacted;
      totals.scanned += result.scanned;
      if (result.isDone) {
        console.log(
          `Compaction complete: scanned=${totals.scanned} deleted=${totals.deleted} compacted=${totals.compacted}`
        );
        return;
      }
      cursor = result.continueCursor;
    }

    console.log(
      `Compaction progress: scanned=${totals.scanned} deleted=${totals.deleted} compacted=${totals.compacted} — continuing`
    );
    await ctx.scheduler.runAfter(0, internal.compaction.run, { cursor, totals });
  },
});
