/**
 * One-time background migration: scrubs secret values out of transcript_parts
 * and stored output_fields for every task whose agent has secrets (or any
 * other value a SecretScrubber would redact — provider API keys, OAuth/MCP
 * tokens). Everything written from this point forward is already scrubbed at
 * the sendToRenderer choke point (see agent-manager.ts); this is purely for
 * data that predates that fix.
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
import { SecretScrubber, NOOP_SCRUBBER } from './secret-scrubber'
import { buildSecretEntriesForAgent } from './secret-entries'

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
    const contentChanged = scrubbedContent !== part.content
    const toolChanged = JSON.stringify(scrubbedTool) !== JSON.stringify(part.tool)
    if (!contentChanged && !toolChanged) continue
    changed.push({
      id: part.partId,
      content: scrubbedContent,
      tool: scrubbedTool,
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
  // Cache one scrubber per agent — many tasks share the same agent.
  const scrubberByAgent = new Map<string, SecretScrubber>()
  const scrubberFor = (agentId: string | null | undefined): SecretScrubber | null => {
    if (!agentId) return null
    const cached = scrubberByAgent.get(agentId)
    if (cached) return cached
    const entries = buildSecretEntriesForAgent(db, agentId)
    if (entries.length === 0) {
      scrubberByAgent.set(agentId, NOOP_SCRUBBER)
      return null
    }
    const scrubber = new SecretScrubber(entries)
    scrubberByAgent.set(agentId, scrubber)
    return scrubber
  }

  let tasksWithSecrets = 0
  let partsScanned = 0
  let partsScrubbed = 0
  let outputFieldsScrubbed = 0

  for (const task of tasks) {
    const scrubber = scrubberFor(task.agent_id)
    if (!scrubber || scrubber.isEmpty) continue
    tasksWithSecrets += 1

    const transcriptResult = scrubTaskTranscript(db, task, scrubber)
    partsScanned += transcriptResult.scanned
    partsScrubbed += transcriptResult.scrubbed

    outputFieldsScrubbed += scrubTaskOutputFields(db, task, scrubber)

    // Yield periodically so this never blocks the event loop for the whole
    // scan on a database with many tasks.
    if (tasksWithSecrets % 20 === 0) await new Promise((r) => setImmediate(r))
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
