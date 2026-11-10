/**
 * Transcript snapshot read, shared by the main connection
 * (`DatabaseManager.getTranscriptParts`) and the read-only worker connection
 * (`db-read-worker.ts`), so both return identical records.
 *
 * Kept free of Electron and app imports: it is bundled into the worker.
 */
import type Database from 'better-sqlite3'

export interface TranscriptPartRecord {
  taskId: string
  partId: string
  seq: number
  role: string
  content: string
  partType?: string
  tool?: unknown
  payload?: unknown
  createdAt: number
  updatedAt: number
  /** Global monotonic change cursor for this row (delta subscriptions). */
  rev: number
}

interface TranscriptPartRow {
  task_id: string; part_id: string; seq: number; role: string; content: string
  part_type: string | null; tool: string | null; payload: string | null
  created_at: number; updated_at: number; rev: number | null
}

// Order by REAL event time (created_at), with seq as a stable tiebreaker.
// Insertion order (seq) is not chronological when a partial projection is
// later backfilled with older history — ordering by created_at keeps the
// transcript correct regardless of when each part was ingested.
const ALL_SQL = 'SELECT * FROM transcript_parts WHERE task_id = ? ORDER BY created_at ASC, seq ASC'
const SINCE_SEQ_SQL = 'SELECT * FROM transcript_parts WHERE task_id = ? AND seq > ? ORDER BY created_at ASC, seq ASC'

/** Ordered transcript for a task, optionally only parts after `sinceSeq`. */
export function readTranscriptParts(db: Database.Database, taskId: string, sinceSeq?: number): TranscriptPartRecord[] {
  const rows = (sinceSeq != null
    ? db.prepare(SINCE_SEQ_SQL).all(taskId, sinceSeq)
    : db.prepare(ALL_SQL).all(taskId)
  ) as TranscriptPartRow[]

  return rows.map((r) => ({
    taskId: r.task_id,
    partId: r.part_id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    rev: r.rev ?? 0,
    partType: r.part_type ?? undefined,
    tool: r.tool ? (JSON.parse(r.tool) as unknown) : undefined,
    payload: r.payload ? (JSON.parse(r.payload) as unknown) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}
