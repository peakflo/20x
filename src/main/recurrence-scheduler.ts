import { BrowserWindow } from 'electron'
import type { DatabaseManager, RecurrencePatternRecord, TaskRecord } from './database'
import { createId } from '@paralleldrive/cuid2'

/**
 * RecurrenceScheduler - Manages automatic creation of recurring task instances
 *
 * ## How It Works:
 * 1. Recurring tasks are stored as "templates" with `is_recurring=true` and `recurrence_parent_id=NULL`
 * 2. Templates have a `next_occurrence_at` timestamp indicating when the next instance should be created
 * 3. Every 60 seconds, the scheduler queries templates where `next_occurrence_at <= NOW()`
 * 4. For each due template, it creates a new task instance (copy of template with `recurrence_parent_id` set)
 * 5. The template's `next_occurrence_at` is updated to the next scheduled time
 *
 * ## Offline Catch-Up (Backfill):
 * When the app is closed/offline, missed occurrences are automatically backfilled on startup:
 *
 * **Example Scenario:**
 * - Recurring task: "Daily standup" at 9:00 AM
 * - App closed on Monday 9:00 AM
 * - App reopened on Thursday 2:00 PM
 *
 * **What Happens:**
 * 1. On startup, scheduler runs immediately (before the 60s interval)
 * 2. Finds template with `next_occurrence_at = Monday 9:00 AM` (< NOW)
 * 3. `catchUpMissedOccurrences()` creates instances:
 *    - Monday 9:00 AM (missed)
 *    - Tuesday 9:00 AM (missed)
 *    - Wednesday 9:00 AM (missed)
 *    - Thursday 9:00 AM (missed)
 * 4. Updates template's `next_occurrence_at = Friday 9:00 AM`
 * 5. User sees all 4 missed tasks in their list
 *
 * **Safety Limits:**
 * - Max 100 instances per template per catch-up (prevents runaway creation)
 * - Uses `created_at` timestamp from occurrence time (not current time) for proper sorting
 * - Indexed query on `next_occurrence_at` for performance
 *
 * ## Pattern Support:
 * - Daily: Every N days at specific time
 * - Weekly: Specific weekdays (e.g., Mon/Wed/Fri) at specific time
 * - Monthly: Specific day of month (handles month-end edge cases)
 * - Optional end date constraint
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

          // Catch up on missed occurrences (if offline)
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
   * Backfill missed occurrences when app was offline/closed
   *
   * Example: If app was closed for 3 days and task recurs daily,
   * this creates 3 task instances (one for each missed day)
   */
  private async catchUpMissedOccurrences(template: TaskRecord): Promise<void> {
    if (!template.recurrence_pattern || !template.next_occurrence_at) {
      return
    }

    const now = new Date()
    const maxInstances = 100 // Safety limit: prevent creating thousands if app offline for months
    let instancesCreated = 0
    let currentOccurrence = new Date(template.next_occurrence_at)

    // Loop: create an instance for each missed occurrence until we catch up to NOW
    // Example: If next_occurrence_at = Monday 9am and NOW = Thursday 2pm,
    //          this creates instances for Mon 9am, Tue 9am, Wed 9am, Thu 9am
    while (currentOccurrence <= now && instancesCreated < maxInstances) {
      // Create the missed instance with original occurrence time as created_at
      // This ensures proper chronological sorting in task list
      this.createInstanceFromTemplate(template, currentOccurrence.toISOString())
      instancesCreated++

      // Calculate when the NEXT occurrence should be (after this one)
      const nextOccurrence = this.calculateNextOccurrence(
        template.recurrence_pattern,
        currentOccurrence.toISOString()
      )

      if (!nextOccurrence) {
        // No more occurrences (reached endDate constraint)
        // Mark template as finished by clearing next_occurrence_at
        this.dbManager.db.prepare(`
          UPDATE tasks
          SET next_occurrence_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(now.toISOString(), template.id)
        return
      }

      currentOccurrence = new Date(nextOccurrence)
    }

    // Update template with the next future occurrence
    // Example: If we just created Thu 9am, next_occurrence_at becomes Fri 9am
    const lastOccurrence = new Date(currentOccurrence)
    lastOccurrence.setMinutes(lastOccurrence.getMinutes() - 1) // Adjust to get the actual last created time

    this.dbManager.db.prepare(`
      UPDATE tasks
      SET last_occurrence_at = ?,
          next_occurrence_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      lastOccurrence.toISOString(),
      currentOccurrence.toISOString(),
      now.toISOString(),
      template.id
    )

    console.log(`[RecurrenceScheduler] Created ${instancesCreated} instances for template "${template.title}"`)
  }

  private createInstanceFromTemplate(template: TaskRecord, occurrenceTime: string): void {
    const id = createId()
    const now = new Date().toISOString()

    // Copy task from template, but mark as non-recurring instance
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
      template.status,
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

  calculateNextOccurrence(pattern: RecurrencePatternRecord, after: string): string | null {
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

        // Find next matching weekday
        nextDate = new Date(afterDate)
        nextDate.setDate(nextDate.getDate() + 1) // Start from tomorrow

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
          return null // Couldn't find matching weekday
        }
        break
      }

      case 'monthly': {
        if (!pattern.monthDay) {
          return null
        }

        nextDate = new Date(afterDate)
        nextDate.setMonth(nextDate.getMonth() + pattern.interval)

        // Handle edge case: if monthDay doesn't exist in target month (e.g., Feb 30)
        const targetMonth = nextDate.getMonth()
        nextDate.setDate(Math.min(pattern.monthDay, this.getDaysInMonth(nextDate)))

        // If setting the date caused month to roll over, go back to last day of intended month
        if (nextDate.getMonth() !== targetMonth) {
          nextDate.setDate(0) // Go to last day of previous month
        }

        nextDate.setHours(hours, minutes, 0, 0)
        break
      }

      case 'custom': {
        // For custom patterns, fall back to daily for now
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

    // Check maxOccurrences constraint (would need to track occurrence count)
    // For now, we skip this check as it requires additional state tracking

    return nextDate.toISOString()
  }

  private getDaysInMonth(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  }

  // Helper to deserialize task row (simplified version of database.ts deserializeTask)
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
      recurrence_pattern: row.recurrence_pattern ? JSON.parse(row.recurrence_pattern) : null,
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
