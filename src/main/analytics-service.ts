import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import packageJson from '../../package.json'

interface BufferedAnalyticsEvent {
  event: string
  properties?: Record<string, unknown>
  capturedAt: string
}

export interface AnalyticsServiceOptions {
  posthogKey?: string
  posthogHost?: string
  enabled?: boolean
  flushBatchSize?: number
  maxBufferedEvents?: number
  flushIntervalMs?: number
}

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'
const DEFAULT_FLUSH_BATCH_SIZE = 20
const DEFAULT_MAX_BUFFERED_EVENTS = 1_000
const DEFAULT_FLUSH_INTERVAL_MS = 1_000

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readOrCreateAnonymousId(): string | null {
  try {
    const filePath = join(app.getPath('userData'), 'analytics', 'anonymous-id')
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8').trim()
      if (existing) return existing
    }

    mkdirSync(dirname(filePath), { recursive: true })
    const id = randomUUID()
    writeFileSync(filePath, id, { encoding: 'utf8', mode: 0o600 })
    return id
  } catch (error) {
    console.warn('[Analytics] Failed to initialize anonymous id:', error)
    return null
  }
}

export class AnalyticsService {
  private readonly posthogKey: string
  private readonly posthogHost: string
  private readonly enabled: boolean
  private readonly flushBatchSize: number
  private readonly maxBufferedEvents: number
  private readonly distinctId: string | null
  private readonly buffer: BufferedAnalyticsEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private isFlushing = false

  constructor(options: AnalyticsServiceOptions = {}) {
    this.posthogKey = options.posthogKey ?? process.env['POSTHOG_KEY'] ?? ''
    this.posthogHost = (options.posthogHost ?? process.env['POSTHOG_HOST'] ?? DEFAULT_POSTHOG_HOST).replace(/\/+$/, '')
    this.enabled = options.enabled ?? parseBoolean(process.env['TELEMETRY_ENABLED'], true)
    this.flushBatchSize = options.flushBatchSize ?? parseNumber(process.env['TELEMETRY_FLUSH_BATCH_SIZE'], DEFAULT_FLUSH_BATCH_SIZE)
    this.maxBufferedEvents = options.maxBufferedEvents ?? parseNumber(process.env['TELEMETRY_MAX_BUFFERED_EVENTS'], DEFAULT_MAX_BUFFERED_EVENTS)
    this.distinctId = this.enabled && this.posthogKey ? readOrCreateAnonymousId() : null

    if (this.enabled && this.distinctId) {
      this.flushTimer = setInterval(() => {
        void this.flush()
      }, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
      this.flushTimer.unref?.()
    }
  }

  record(event: string, properties?: Record<string, unknown>): void {
    if (!this.enabled || !this.distinctId) return

    this.buffer.push({
      event,
      properties,
      capturedAt: new Date().toISOString()
    })

    if (this.buffer.length > this.maxBufferedEvents) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferedEvents)
    }
  }

  async flush(): Promise<void> {
    if (!this.enabled || !this.distinctId || this.isFlushing || this.buffer.length === 0) return

    this.isFlushing = true
    const batch = this.buffer.splice(0, this.flushBatchSize)

    try {
      const response = await fetch(`${this.posthogHost}/batch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.posthogKey,
          batch: batch.map((item) => ({
            event: item.event,
            distinct_id: this.distinctId,
            timestamp: item.capturedAt,
            properties: {
              ...item.properties,
              $process_person_profile: false,
              platform: process.platform,
              arch: process.arch,
              appVersion: packageJson.version,
              clientType: 'desktop-app'
            }
          }))
        })
      })

      if (!response.ok) {
        throw new Error(`PostHog batch failed with ${response.status}`)
      }
    } catch (error) {
      this.buffer.unshift(...batch)
      console.warn('[Analytics] Failed to flush events:', error)
    } finally {
      this.isFlushing = false
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }
}

let analyticsService: AnalyticsService | null = null

export function initAnalytics(options?: AnalyticsServiceOptions): AnalyticsService {
  analyticsService ??= new AnalyticsService(options)
  return analyticsService
}

export function analytics(): AnalyticsService | null {
  return analyticsService
}

export async function shutdownAnalytics(): Promise<void> {
  await analyticsService?.shutdown()
}
