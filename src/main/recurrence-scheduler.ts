import { BrowserWindow } from 'electron'
import { CronExpressionParser } from 'cron-parser'
import type { DatabaseManager, RecurrencePatternRecord, RecurrencePatternObject, TaskRecord } from './database'
import { createId } from '@paralleldrive/cuid2'
import { TaskStatus } from '../shared/constants'

/**
 * RecurrenceScheduler - Manages automatic creation of recurring task instances
 *
 * Supports two pattern formats:
 * 1. **Cron strings** (new): e.g. `"0 9 * * 1-5"` — parsed via cron-parser
 * 2. **Legacy JSON objects** (backward compat): `{ type, interval, time, weekdays, ... }`
 *
 * ## How It Works:
 * 1. Recurring tasks are stored as "templates" with `is_recurring=true` and `recurrence_parent_id=NULL`
 * 2. Templates have a `next_occurrence_at` timestamp indicating when the next instance should be created
 * 3. Every 60 seconds, the scheduler queries templates where `next_occurrence_at <= NOW()`
 * 4. For each due template, it creates ONE instance (the latest missed occurrence)
 * 5. The template's `next_occurrence_at` is advanced to the next future time
 */
export class RecurrenceScheduler {
  private dbManager: DatabaseManager
  private intervalId: NodeJS.Timeout | null = null
  private mainWindow: BrowserWindow | null = null
  private readonly CHECK_INTERVAL = 60 * 1000 // 60 seconds

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
  }

  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    console.log('[RecurrenceScheduler] Starting scheduler...')

    // Repair recurring templates missing next_occurrence_at
    this.repairMissingNextOccurrence()

    // Run immediately on startup to catch up on missed occurrences
    this.checkAndCreateDueInstances()

    // Then run every 60 seconds
    this.intervalId = setInterval(() => {
      this.checkAndCreateDueInstances()
    }, this.CHECK_INTERVAL)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('[RecurrenceScheduler] Scheduler stopped')
    }
  }

  /**
   * Fix recurring templates that have a recurrence_pattern but no next_occurrence_at.
   * This can happen when tasks are created via MCP without calling initializeRecurringTask.
   */
  private repairMissingNextOccurrence(): void {
    try {
      const broken = this.dbManager.db.prepare(`
        SELECT id, recurrence_pattern FROM tasks
        WHERE is_recurring = 1
          AND recurrence_parent_id IS NULL
          AND recurrence_pattern IS NOT NULL
          AND next_occurrence_at IS NULL
      `).all() as { id: string; recurrence_pattern: string }[]

      if (broken.length === 0) return

      console.log(`[RecurrenceScheduler] Repairing ${broken.length} recurring tasks missing next_occurrence_at`)

      for (const row of broken) {
        const pattern: RecurrencePatternRecord = row.recurrence_pattern.startsWith('{')
          ? JSON.parse(row.recurrence_pattern)
          : row.recurrence_pattern

        const now = new Date().toISOString()
        const next = this.calculateNextOccurrence(pattern, now)

        if (next) {
          this.dbManager.db.prepare(`
            UPDATE tasks SET next_occurrence_at = ?, updated_at = ? WHERE id = ?
          `).run(next, now, row.id)
          console.log(`[RecurrenceScheduler] Repaired task ${row.id}: next_occurrence_at = ${next}`)
        }
      }
    } catch (err) {
      console.error('[RecurrenceScheduler] Error repairing recurring tasks:', err)
    }
  }

  private async checkAndCreateDueInstances(): Promise<void> {
    try {
      const now = new Date().toISOString()

      // Query templates where next_occurrence_at <= NOW()
      const dueTemplates = this.dbManager.db.prepare(`
        SELECT * FROM tasks
        WHERE is_recurring = 1
          AND recurrence_parent_id IS NULL
          AND next_occurrence_at IS NOT NULL
          AND next_occurrence_at <= ?
        ORDER BY next_occurrence_at ASC
      `).all(now) as any[]

      if (dueTemplates.length === 0) {
        return
      }

      console.log(`[RecurrenceScheduler] Found ${dueTemplates.length} due templates`)

      // Process each template
      for (const templateRow of dueTemplates) {
        try {
          const template = this.deserializeTaskRow(templateRow)
          await this.catchUpMissedOccurrences(template)
        } catch (err) {
          console.error(`[RecurrenceScheduler] Error processing template ${templateRow.id}:`, err)
        }
      }

      // Notify renderer to refresh tasks
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('tasks:refresh')
      }
    } catch (err) {
      console.error('[RecurrenceScheduler] Error in checkAndCreateDueInstances:', err)
    }
  }

  /**
   * Simplified backfill: create ONE instance for the latest missed occurrence,
   * then fast-forward next_occurrence_at to the next future time.
   */
  private async catchUpMissedOccurrences(template: TaskRecord): Promise<void> {
    if (!template.recurrence_pattern || !template.next_occurrence_at) {
      return
    }

    const now = new Date()

    // Create one instance for the current (latest missed) occurrence
    this.createInstanceFromTemplate(template, template.next_occurrence_at)

    // Fast-forward: find the next future occurrence after NOW
    let nextOccurrence = this.calculateNextOccurrence(
      template.recurrence_pattern,
      template.next_occurrence_at
    )

    // Skip past any still-missed occurrences to find the next future one
    let iterations = 0
    while (nextOccurrence && new Date(nextOccurrence) <= now && iterations < 1000) {
      nextOccurrence = this.calculateNextOccurrence(
        template.recurrence_pattern,
        nextOccurrence
      )
      iterations++
    }

    if (!nextOccurrence) {
      // No more occurrences — mark template as finished
      this.dbManager.db.prepare(`
        UPDATE tasks
        SET next_occurrence_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now.toISOString(), template.id)
      return
    }

    this.dbManager.db.prepare(`
      UPDATE tasks
      SET last_occurrence_at = ?,
          next_occurrence_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      template.next_occurrence_at,
      nextOccurrence,
      now.toISOString(),
      template.id
    )

    console.log(`[RecurrenceScheduler] Created 1 instance for template "${template.title}", next: ${nextOccurrence}`)
  }

  private createInstanceFromTemplate(template: TaskRecord, occurrenceTime: string): void {
    const id = createId()
    const now = new Date().toISOString()

    this.dbManager.db.prepare(`
      INSERT INTO tasks (
        id, title, description, type, priority, status, assignee, due_date,
        labels, attachments, repos, output_fields, agent_id, source, skill_ids,
        is_recurring, recurrence_pattern, recurrence_parent_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      template.title,
      template.description,
      template.type,
      template.priority,
      TaskStatus.NotStarted,
      template.assignee,
      template.due_date,
      JSON.stringify(template.labels),
      JSON.stringify(template.attachments),
      JSON.stringify(template.repos),
      JSON.stringify(template.output_fields),
      template.agent_id,
      template.source,
      template.skill_ids ? JSON.stringify(template.skill_ids) : null,
      0, // Not recurring
      null, // No recurrence pattern
      template.id, // Link back to template
      occurrenceTime, // Use occurrence time as created_at
      now
    )

    console.log(`[RecurrenceScheduler] Created instance ${id} from template ${template.id}`)
  }

  /**
   * Calculate the next occurrence after `after`.
   * Accepts a cron expression string or a legacy JSON pattern object.
   */
  calculateNextOccurrence(pattern: RecurrencePatternRecord, after: string): string | null {
    // New path: cron string
    if (typeof pattern === 'string') {
      return this.calculateNextFromCron(pattern, after)
    }

    // Legacy path: JSON object
    return this.calculateNextFromLegacy(pattern, after)
  }

  private calculateNextFromCron(cron: string, after: string): string | null {
    try {
      const interval = CronExpressionParser.parse(cron, {
        currentDate: new Date(after),
        tz: 'UTC'
      })
      return interval.next().toISOString()
    } catch {
      return null
    }
  }

  private calculateNextFromLegacy(pattern: RecurrencePatternObject, after: string): string | null {
    const afterDate = new Date(after)
    const [hours, minutes] = pattern.time.split(':').map(Number)

    let nextDate: Date

    switch (pattern.type) {
      case 'daily': {
        nextDate = new Date(afterDate)
        nextDate.setDate(nextDate.getDate() + pattern.interval)
        nextDate.setHours(hours, minutes, 0, 0)
        break
      }

      case 'weekly': {
        if (!pattern.weekdays || pattern.weekdays.length === 0) {
          return null
        }

        nextDate = new Date(afterDate)
        nextDate.setDate(nextDate.getDate() + 1)

        let daysChecked = 0
        while (daysChecked < 7 * pattern.interval) {
          const dayOfWeek = nextDate.getDay()
          if (pattern.weekdays.includes(dayOfWeek)) {
            nextDate.setHours(hours, minutes, 0, 0)
            break
          }
          nextDate.setDate(nextDate.getDate() + 1)
          daysChecked++
        }

        if (daysChecked >= 7 * pattern.interval) {
          return null
        }
        break
      }

      case 'monthly': {
        if (!pattern.monthDay) {
          return null
        }

        nextDate = new Date(afterDate)
        nextDate.setMonth(nextDate.getMonth() + pattern.interval)

        const targetMonth = nextDate.getMonth()
        nextDate.setDate(Math.min(pattern.monthDay, this.getDaysInMonth(nextDate)))

        if (nextDate.getMonth() !== targetMonth) {
          nextDate.setDate(0)
        }

        nextDate.setHours(hours, minutes, 0, 0)
        break
      }

      case 'custom': {
        nextDate = new Date(afterDate)
        nextDate.setDate(nextDate.getDate() + pattern.interval)
        nextDate.setHours(hours, minutes, 0, 0)
        break
      }

      default:
        return null
    }

    // Check endDate constraint
    if (pattern.endDate && nextDate > new Date(pattern.endDate)) {
      return null
    }

    return nextDate.toISOString()
  }

  private getDaysInMonth(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  }

  private deserializeTaskRow(row: any): TaskRecord {
    return {
      ...row,
      labels: JSON.parse(row.labels || '[]'),
      attachments: JSON.parse(row.attachments || '[]'),
      repos: JSON.parse(row.repos || '[]'),
      output_fields: JSON.parse(row.output_fields || '[]'),
      agent_id: row.agent_id ?? null,
      external_id: row.external_id ?? null,
      source_id: row.source_id ?? null,
      skill_ids: row.skill_ids ? JSON.parse(row.skill_ids) : null,
      session_id: row.session_id ?? null,
      snoozed_until: row.snoozed_until ?? null,
      resolution: row.resolution ?? null,
      is_recurring: row.is_recurring === 1,
      recurrence_pattern: row.recurrence_pattern
        ? (row.recurrence_pattern.startsWith('{')
            ? JSON.parse(row.recurrence_pattern)
            : row.recurrence_pattern)
        : null,
      recurrence_parent_id: row.recurrence_parent_id ?? null,
      last_occurrence_at: row.last_occurrence_at ?? null,
      next_occurrence_at: row.next_occurrence_at ?? null
    }
  }

  // Public method to initialize next_occurrence_at for a newly created recurring task
  initializeRecurringTask(taskId: string): void {
    const task = this.dbManager.getTask(taskId)
    if (!task || !task.is_recurring || !task.recurrence_pattern) {
      return
    }

    const now = new Date().toISOString()
    const nextOccurrence = this.calculateNextOccurrence(task.recurrence_pattern, now)

    if (nextOccurrence) {
      this.dbManager.db.prepare(`
        UPDATE tasks
        SET next_occurrence_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nextOccurrence, now, taskId)

      console.log(`[RecurrenceScheduler] Initialized recurring task ${taskId} with next occurrence: ${nextOccurrence}`)
    }
  }
}
