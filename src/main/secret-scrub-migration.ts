/**
 * One-time background migration: scrubs secret values out of transcript_parts
 * (content, tool, AND payload columns) and stored output_fields for every
 * task in the database against every secret value this installation has
 * ever stored (see `buildAllKnownSecretEntries`) — not just the secrets of
 * whichever agent a task happens to be attached to right now, so a
 * reassigned or deleted agent_id, or a secret later removed from an agent's
 * config, still gets scrubbed. Everything written from this point forward
 * is already scrubbed at the sendToRenderer choke point (see
 * agent-manager.ts); this is purely for data that predates that fix.
 *
 * Idempotent by construction, not just by a completion flag: scrubbing
 * already-scrubbed text is a no-op (the placeholder `«$VAR»` doesn't match
 * the original secret value, so re-running finds nothing left to redact).
 * The completion flag (SECRET_SCRUB_MIGRATION_SETTING) exists only to skip
 * re-scanning the whole database on every app start once it's done; a task
 * created or an agent's secrets added/rotated AFTER the flag is set don't
 * need this migration at all — their output is scrubbed live by the choke
 * point from the moment they exist.
 */

import type { DatabaseManager, TaskRecord, TranscriptPartInput } from './database'
import { SecretScrubber } from './secret-scrubber'
import { buildAllKnownSecretEntries } from './secret-entries'

export const SECRET_SCRUB_MIGRATION_SETTING = 'secret-scrub-migration-completed-v1'

export interface SecretScrubMigrationResult {
  tasksScanned: number
  tasksWithSecrets: number
  partsScanned: number
  partsScrubbed: number
  outputFieldsScrubbed: number
  durationMs: number
}

function scrubTaskTranscript(db: DatabaseManager, task: TaskRecord, scrubber: SecretScrubber): { scanned: number; scrubbed: number } {
  const parts = db.getTranscriptParts(task.id)
  const changed: TranscriptPartInput[] = []
  for (const part of parts) {
    const scrubbedContent = part.content ? scrubber.scrub(part.content) ?? part.content : part.content
    const scrubbedTool = part.tool !== undefined ? scrubber.scrubDeep(part.tool) : part.tool
    // `payload` carries the raw agent:output event (mirrors transcript-part
    // input shape) — it can contain the same secret values as `content`/`tool`
    // (e.g. a tool_response embedded verbatim) and was previously skipped here.
    const scrubbedPayload = part.payload !== undefined ? scrubber.scrubDeep(part.payload) : part.payload
    const contentChanged = scrubbedContent !== part.content
    const toolChanged = JSON.stringify(scrubbedTool) !== JSON.stringify(part.tool)
    const payloadChanged = JSON.stringify(scrubbedPayload) !== JSON.stringify(part.payload)
    if (!contentChanged && !toolChanged && !payloadChanged) continue
    changed.push({
      id: part.partId,
      content: scrubbedContent,
      tool: scrubbedTool,
      payload: scrubbedPayload,
      receivedAt: part.createdAt
    })
  }
  if (changed.length > 0) db.upsertTranscriptParts(task.id, changed)
  return { scanned: parts.length, scrubbed: changed.length }
}

function scrubTaskOutputFields(db: DatabaseManager, task: TaskRecord, scrubber: SecretScrubber): number {
  if (!task.output_fields || task.output_fields.length === 0) return 0
  let changedCount = 0
  const updated = task.output_fields.map((field) => {
    if (field.value === undefined || field.value === null) return field
    const scrubbedValue = scrubber.scrubDeep(field.value)
    if (JSON.stringify(scrubbedValue) === JSON.stringify(field.value)) return field
    changedCount += 1
    return { ...field, value: scrubbedValue }
  })
  if (changedCount > 0) db.updateTask(task.id, { output_fields: updated })
  return changedCount
}

/**
 * Runs the migration if it hasn't completed yet. Safe to call on every app
 * start — a no-op read of one setting when already done. Caller should
 * invoke this off the startup critical path (fire-and-forget); it does its
 * own DB reads/writes synchronously but in small per-task batches so it
 * never holds a long-running transaction.
 */
export async function runSecretScrubMigrationIfNeeded(db: DatabaseManager): Promise<SecretScrubMigrationResult | null> {
  if (db.getSetting(SECRET_SCRUB_MIGRATION_SETTING)) return null
  const result = await runSecretScrubMigration(db)
  db.setSetting(SECRET_SCRUB_MIGRATION_SETTING, new Date().toISOString())
  return result
}

/** Runs the scrub unconditionally — exported for the one-time runner above and for tests. */
export async function runSecretScrubMigration(db: DatabaseManager): Promise<SecretScrubMigrationResult> {
  const start = Date.now()
  const tasks = db.getTasks()

  // ONE scrubber built from every secret this installation has ever stored
  // plus every agent's provider API keys — not scoped to a task's CURRENT
  // `agent_id`. Scoping per-agent missed: tasks whose agent was reassigned
  // or deleted after the run that leaked the value (agent_id no longer
  // resolves, or resolves to a different agent than the one that produced
  // the transcript), and secrets removed from an agent's config after the
  // leak happened. A historical scrub has to assume any value this app ever
  // held could be sitting in any task's old transcript text.
  const scrubber = new SecretScrubber(buildAllKnownSecretEntries(db))

  let tasksWithSecrets = 0
  let partsScanned = 0
  let partsScrubbed = 0
  let outputFieldsScrubbed = 0

  if (!scrubber.isEmpty) {
    let processed = 0
    for (const task of tasks) {
      const transcriptResult = scrubTaskTranscript(db, task, scrubber)
      partsScanned += transcriptResult.scanned
      partsScrubbed += transcriptResult.scrubbed

      const fieldsScrubbed = scrubTaskOutputFields(db, task, scrubber)
      outputFieldsScrubbed += fieldsScrubbed

      if (transcriptResult.scrubbed > 0 || fieldsScrubbed > 0) tasksWithSecrets += 1

      // Yield periodically so this never blocks the event loop for the whole
      // scan on a database with many tasks.
      processed += 1
      if (processed % 20 === 0) await new Promise((r) => setImmediate(r))
    }
  }

  return {
    tasksScanned: tasks.length,
    tasksWithSecrets,
    partsScanned,
    partsScrubbed,
    outputFieldsScrubbed,
    durationMs: Date.now() - start
  }
}
