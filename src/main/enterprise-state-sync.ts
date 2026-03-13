/**
 * EnterpriseStateSync — Phase 2.7
 *
 * Syncs local task state changes to Workflo after task imports.
 * Collects events (task status changes, agent runs, feedback) and
 * sends them in batches to the Workflo API.
 *
 * 20x only sends raw events — all stats computation happens on
 * the Workflo side using humanTasks + orgNodeChangelog + heartbeats.
 *
 * Usage:
 *   1. Call recordEvent() whenever a task status changes or
 *      an agent run completes.
 *   2. Call flush() after task sync to send all pending events.
 */
import type { WorkfloApiClient, WorkfloSyncEvent } from './workflo-api-client'
import type { TaskRecord } from './database'
import { TaskStatus } from '../shared/constants'

// ── Event queue ─────────────────────────────────────────────────────────

export class EnterpriseStateSync {
  private pendingEvents: WorkfloSyncEvent[] = []
  private apiClient: WorkfloApiClient
  private userName: string | null = null
  private isFlushing = false

  constructor(apiClient: WorkfloApiClient) {
    this.apiClient = apiClient
  }

  /**
   * Set the display name used in changelog entries.
   */
  setUserName(name: string): void {
    this.userName = name
  }

  /**
   * Update the API client reference.
   */
  setApiClient(apiClient: WorkfloApiClient): void {
    this.apiClient = apiClient
  }

  // ── Event recording ───────────────────────────────────────────────────

  /**
   * Record a task status change event.
   */
  recordTaskStatusChange(
    task: TaskRecord,
    previousStatus: string,
    newStatus: string
  ): void {
    this.pendingEvents.push({
      eventType: 'task_status_changed',
      entityType: 'task',
      entityId: task.external_id || task.id,
      entityTitle: task.title,
      previousValue: previousStatus,
      newValue: newStatus,
      userName: this.userName || undefined,
      occurredAt: new Date().toISOString(),
      eventData: {
        localTaskId: task.id,
        externalId: task.external_id || null,
        sourceId: task.source_id || null
      }
    })
  }

  /**
   * Record a task creation event.
   */
  recordTaskCreated(task: TaskRecord): void {
    this.pendingEvents.push({
      eventType: 'task_created',
      entityType: 'task',
      entityId: task.external_id || task.id,
      entityTitle: task.title,
      newValue: task.status,
      userName: this.userName || undefined,
      occurredAt: new Date().toISOString()
    })
  }

  /**
   * Record a task completion event.
   * Optionally includes action outputs so Workflo can propagate them
   * to the task source (replaces the direct executeAction API call).
   */
  recordTaskCompleted(
    task: TaskRecord,
    opts?: { action?: string; outputs?: Record<string, unknown> }
  ): void {
    this.pendingEvents.push({
      eventType: 'task_completed',
      entityType: 'task',
      entityId: task.external_id || task.id,
      entityTitle: task.title,
      previousValue: task.status,
      newValue: TaskStatus.Completed,
      userName: this.userName || undefined,
      occurredAt: new Date().toISOString(),
      eventData: {
        localTaskId: task.id,
        externalId: task.external_id || null,
        sourceId: task.source_id || null,
        ...(opts?.action ? { action: opts.action } : {}),
        ...(opts?.outputs ? { outputs: opts.outputs } : {})
      }
    })
  }

  /**
   * Record an agent run start event.
   */
  recordAgentRunStarted(task: TaskRecord, agentName?: string): void {
    this.pendingEvents.push({
      eventType: 'agent_run_started',
      entityType: 'task',
      entityId: task.external_id || task.id,
      entityTitle: task.title,
      userName: this.userName || undefined,
      occurredAt: new Date().toISOString(),
      eventData: { agentName: agentName || null }
    })
  }

  /**
   * Record an agent run completion event.
   */
  recordAgentRunCompleted(
    task: TaskRecord,
    opts?: { agentName?: string; durationMinutes?: number; messageCount?: number; success?: boolean }
  ): void {
    this.pendingEvents.push({
      eventType: opts?.success === false ? 'agent_run_failed' : 'agent_run_completed',
      entityType: 'task',
      entityId: task.external_id || task.id,
      entityTitle: task.title,
      userName: this.userName || undefined,
      occurredAt: new Date().toISOString(),
      eventData: {
        agentName: opts?.agentName || null,
        durationMinutes: opts?.durationMinutes || null,
        messageCount: opts?.messageCount || null,
        success: opts?.success !== false
      }
    })
  }

  /**
   * Record a human feedback event.
   */
  recordFeedbackSubmitted(
    task: TaskRecord,
    rating: number
  ): void {
    this.pendingEvents.push({
      eventType: 'feedback_submitted',
      entityType: 'task',
      entityId: task.external_id || task.id,
      entityTitle: task.title,
      newValue: String(rating),
      userName: this.userName || undefined,
      occurredAt: new Date().toISOString(),
      eventData: { rating }
    })
  }

  // ── Flush (send pending events) ─────────────────────────────────────

  /**
   * Send all pending events to Workflo.
   * Called after task sync completes.
   *
   * Stats are computed entirely on Workflo side from humanTasks +
   * orgNodeChangelog + orgNodeHeartbeats — 20x only sends events.
   *
   * Returns silently on error (non-fatal).
   */
  async flush(): Promise<void> {
    if (this.isFlushing) return
    this.isFlushing = true

    try {
      if (this.pendingEvents.length > 0) {
        const events = [...this.pendingEvents]
        this.pendingEvents = []

        try {
          const result = await this.apiClient.sendSyncEvents(events)
          console.log(`[EnterpriseStateSync] Sent ${result.inserted} events`)
        } catch (err) {
          // Re-queue events on failure (they'll be sent next flush)
          this.pendingEvents.unshift(...events)
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[EnterpriseStateSync] Failed to send events: ${msg}`)
        }
      }
    } finally {
      this.isFlushing = false
    }
  }

  /**
   * Returns the number of pending events not yet sent.
   */
  get pendingCount(): number {
    return this.pendingEvents.length
  }
}
