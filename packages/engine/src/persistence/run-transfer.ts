import { LogEventSchema, RUN_STATUSES } from "@path/schema";
import type Database from "better-sqlite3";
import { z } from "zod";

/**
 * One root run's stored rows as they cross between stores (ADR 0091): the `runs` and `log_events`
 * columns verbatim, so nothing a row records is lost on the way.
 */
export interface RunTreeExport {
  runs: Record<string, string | number | null>[];
  events: Record<string, string | number | null>[];
}

export type ImportTreeResult = { ok: true } | { ok: false; error: string };

const text = z.string().nullable();
const integer = z.number().int().nullable();

const RunRowSchema = z
  .object({
    run_id: z.string().min(1),
    root_run_id: z.string(),
    parent_run_id: text,
    node_id: text,
    node_name: text,
    worker_name: text,
    iteration: integer,
    pass: integer,
    status: z.enum(RUN_STATUSES),
    started_at: text,
    finished_at: text,
    input_ref: text,
    output_ref: text,
    usage: text,
    estimated_cost_usd: z.number().nullable(),
    resumed_from_root_run_id: text,
    rerun_from_node_path: text,
    reused_from_run_id: text,
    workflow_id: text,
    workflow_name: text,
    workflow_path: text,
    launch_facts: text,
  })
  .partial()
  .required({ run_id: true, status: true })
  .strict();

const EventRowSchema = z
  .object({
    root_run_id: z.string(),
    seq: z.number().int().positive(),
    ts: z.string(),
    type: z.string(),
    run_id: z.string(),
    node_id: text,
    node_name: text,
    event: z.string(),
  })
  .strict();

const TreeExportSchema = z
  .object({
    runs: z.array(RunRowSchema),
    events: z.array(EventRowSchema),
  })
  .strict();

type RunRow = z.infer<typeof RunRowSchema>;

const RUN_COLUMNS = Object.keys(RunRowSchema.shape) as (keyof RunRow)[];

export function exportTree(db: Database.Database, rootRunId: string): RunTreeExport | null {
  const runs = db
    .prepare(`SELECT * FROM runs WHERE root_run_id = @rootRunId ORDER BY rowid`)
    .all({ rootRunId }) as RunTreeExport["runs"];
  if (runs.length === 0) return null;
  const events = db
    .prepare(`SELECT * FROM log_events WHERE root_run_id = @rootRunId ORDER BY seq`)
    .all({ rootRunId }) as RunTreeExport["events"];
  return { runs, events };
}

/** A blob ref a row may hold: `runs/<root>/<run>/<file>`, no `.` or `..` segment. */
function confinedRef(ref: string, rootRunId: string): boolean {
  const parts = ref.split("/");
  return (
    parts.length === 4 &&
    parts[0] === "runs" &&
    parts[1] === rootRunId &&
    parts.slice(2).every((part) => part !== "" && part !== "." && part !== ".." && !/\\/.test(part))
  );
}

/**
 * Writes an exported tree into `db` as root `rootRunId`, replacing what the db held for that root.
 * Every row is forced onto the root, and the tree is refused whole when a row is malformed, a run
 * id belongs to another tree, an event names a run outside it, or a blob ref leaves the root's
 * directory.
 */
export function importTree(
  db: Database.Database,
  rootRunId: string,
  exported: unknown,
): ImportTreeResult {
  const parsed = TreeExportSchema.safeParse(exported);
  if (!parsed.success) return { ok: false, error: `malformed export: ${parsed.error.message}` };
  const runs = parsed.data.runs.map((row) => ({ ...row, root_run_id: rootRunId }));
  const events = parsed.data.events.map((row) => ({ ...row, root_run_id: rootRunId }));

  const root = runs.find((row) => row.run_id === rootRunId);
  if (root === undefined || (root.parent_run_id ?? null) !== null) {
    return { ok: false, error: `the export has no root row for ${rootRunId}` };
  }
  const ids = new Set<string>();
  for (const row of runs) {
    if (ids.has(row.run_id)) return { ok: false, error: `run id ${row.run_id} appears twice` };
    ids.add(row.run_id);
    for (const ref of [row.input_ref, row.output_ref]) {
      if (ref != null && !confinedRef(ref, rootRunId)) {
        return { ok: false, error: `blob ref ${ref} is outside runs/${rootRunId}/` };
      }
    }
  }
  const owner = db.prepare(`SELECT root_run_id FROM runs WHERE run_id = ?`);
  for (const id of ids) {
    const held = owner.get(id) as { root_run_id: string } | undefined;
    if (held !== undefined && held.root_run_id !== rootRunId) {
      return { ok: false, error: `run id ${id} belongs to another run tree` };
    }
  }
  for (const row of events) {
    if (!ids.has(row.run_id)) {
      return { ok: false, error: `log event ${row.seq} names run ${row.run_id} outside the tree` };
    }
    let event: unknown;
    try {
      event = JSON.parse(row.event);
    } catch {
      return { ok: false, error: `log event ${row.seq} is not JSON` };
    }
    if (!LogEventSchema.safeParse(event).success) {
      return { ok: false, error: `log event ${row.seq} is not a valid log event` };
    }
  }

  const insertRun = db.prepare(
    `INSERT INTO runs (${RUN_COLUMNS.join(", ")}) VALUES (${RUN_COLUMNS.map((c) => `@${c}`).join(", ")})`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO log_events (root_run_id, seq, ts, type, run_id, node_id, node_name, event)
     VALUES (@root_run_id, @seq, @ts, @type, @run_id, @node_id, @node_name, @event)`,
  );
  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM runs WHERE root_run_id = ?`).run(rootRunId);
      db.prepare(`DELETE FROM log_events WHERE root_run_id = ?`).run(rootRunId);
      for (const row of runs) {
        insertRun.run(Object.fromEntries(RUN_COLUMNS.map((c) => [c, row[c] ?? null])));
      }
      for (const row of events) insertEvent.run(row);
    })();
  } catch (err) {
    return { ok: false, error: `import failed: ${err instanceof Error ? err.message : err}` };
  }
  return { ok: true };
}
