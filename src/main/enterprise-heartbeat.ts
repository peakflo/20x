/**
 * EnterpriseHeartbeat — Phase 2.7
 *
 * Sends a heartbeat ping to Workflo every 60 seconds when the 20x app
 * is running in enterprise mode (user has authenticated + selected a tenant).
 *
 * Lifecycle:
 *   1. start() — called after enterprise selectTenant succeeds, or on
 *      app restart when a previous enterprise session is restored.
 *   2. stop()  — called on enterprise logout or app quit.
 *
 * The heartbeat tells Workflo that this desktop instance is active,
 * enabling the "Active Users per Day" dashboard chart and real-time
 * active-user indicators.
 */
import { app } from 'electron'
import type { WorkfloApiClient } from './workflo-api-client'
import type { EnterpriseStateSync } from './enterprise-state-sync'

const HEARTBEAT_INTERVAL_MS = 60_000 // 1 minute

export class EnterpriseHeartbeat {
  private intervalId: NodeJS.Timeout | null = null
  private apiClient: WorkfloApiClient
  private stateSync: EnterpriseStateSync | null = null
  private userEmail: string | null = null
  private userName: string | null = null
  private consecutiveErrors = 0
  private readonly MAX_CONSECUTIVE_ERRORS = 5

  constructor(apiClient: WorkfloApiClient) {
    this.apiClient = apiClient
  }

  /**
   * Attach an EnterpriseStateSync instance so pending events
   * are flushed alongside every heartbeat (every 60s).
   */
  setStateSync(stateSync: EnterpriseStateSync | null): void {
    this.stateSync = stateSync
  }

  /**
   * Start sending heartbeats. Idempotent — stops any existing timer first.
   */
  start(opts?: { userEmail?: string; userName?: string }): void {
    this.stop() // clear any previous timer

    this.userEmail = opts?.userEmail || null
    this.userName = opts?.userName || null
    this.consecutiveErrors = 0

    console.log('[EnterpriseHeartbeat] Starting (interval: 60s)')

    // Send immediately, then every 60s
    this.sendHeartbeat()
    this.intervalId = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS)
  }

  /**
   * Stop sending heartbeats.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('[EnterpriseHeartbeat] Stopped')
    }
  }

  /**
   * Whether the heartbeat timer is currently running.
   */
  get isRunning(): boolean {
    return this.intervalId !== null
  }

  /**
   * Update the API client reference (e.g. after token refresh reconnect).
   */
  setApiClient(apiClient: WorkfloApiClient): void {
    this.apiClient = apiClient
  }

  // ── Private ───────────────────────────────────────────────────────────

  private async sendHeartbeat(): Promise<void> {
    try {
      const appVersion = app.getVersion()

      await this.apiClient.sendHeartbeat({
        appVersion,
        userEmail: this.userEmail || undefined,
        userName: this.userName || undefined
      })

      this.consecutiveErrors = 0

      // Flush any pending enterprise state sync events (agent runs, feedback, etc.)
      // This ensures events reach Workflo within ~60s instead of waiting for manual task sync.
      if (this.stateSync) {
        this.stateSync.flush().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[EnterpriseHeartbeat] State sync flush error (non-fatal): ${msg}`)
        })
      }
    } catch (err) {
      this.consecutiveErrors++
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[EnterpriseHeartbeat] Failed (${this.consecutiveErrors}/${this.MAX_CONSECUTIVE_ERRORS}): ${msg}`
      )

      // After too many consecutive errors, stop to avoid log spam.
      // The heartbeat will be restarted on next successful auth.
      if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        console.error(
          '[EnterpriseHeartbeat] Too many consecutive errors, stopping.'
        )
        this.stop()
      }
    }
  }
}
