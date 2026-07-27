import posthog from 'posthog-js'
import type { Properties } from 'posthog-js'

type AnalyticsProperties = Properties
type AnalyticsPlatform = 'desktop' | 'mobile'

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com'
const POSTHOG_RECORD_SESSIONS = import.meta.env.VITE_POSTHOG_RECORD_SESSIONS !== 'false'

let initialized = false
let identifiedId: string | null = null
let appPlatform: AnalyticsPlatform = 'desktop'

function isEnabled(): boolean {
  return typeof window !== 'undefined' && Boolean(POSTHOG_KEY)
}

export function initAnalytics(platform: AnalyticsPlatform = 'desktop'): void {
  appPlatform = platform
  if (!isEnabled() || initialized) return

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: true,
    disable_session_recording: !POSTHOG_RECORD_SESSIONS,
    loaded: (client) => {
      if (POSTHOG_RECORD_SESSIONS) client.startSessionRecording()
    },
    persistence: 'localStorage+cookie'
  })

  initialized = true
}

export function identifyAnalyticsUser(
  distinctId: string | null | undefined,
  properties: AnalyticsProperties = {}
): void {
  initAnalytics(appPlatform)
  if (!isEnabled() || !distinctId || identifiedId === distinctId) return

  posthog.identify(distinctId, cleanProperties({
    ...properties,
    app_platform: appPlatform
  }))
  identifiedId = distinctId
}

export function resetAnalyticsUser(): void {
  if (!isEnabled() || !initialized) return
  posthog.reset()
  identifiedId = null
}

export function captureAnalyticsEvent(event: string, properties: AnalyticsProperties = {}): void {
  initAnalytics(appPlatform)
  if (!isEnabled()) return

  posthog.capture(event, cleanProperties({
    ...properties,
    app_platform: appPlatform
  }))
}

export function capturePageView(name: string, properties: AnalyticsProperties = {}): void {
  captureAnalyticsEvent('$pageview', {
    page_name: name,
    path: typeof window !== 'undefined' ? window.location.pathname : undefined,
    ...properties
  })
}

export function getTaskAnalyticsProperties(task: {
  id?: string
  type?: string
  priority?: string
  status?: string
  labels?: unknown[]
  attachments?: unknown[]
  repos?: unknown[]
  output_fields?: unknown[]
  agent_id?: string | null
  source?: string | null
  source_id?: string | null
  parent_task_id?: string | null
  is_recurring?: boolean | number
  heartbeat_enabled?: boolean | number | null
  auto_start_agent?: boolean | number
  auto_complete_without_review?: boolean | number
}): AnalyticsProperties {
  return {
    task_id: task.id,
    task_type: task.type,
    task_priority: task.priority,
    task_status: task.status,
    task_label_count: task.labels?.length ?? 0,
    task_attachment_count: task.attachments?.length ?? 0,
    task_repo_count: task.repos?.length ?? 0,
    task_output_field_count: task.output_fields?.length ?? 0,
    has_agent: Boolean(task.agent_id),
    agent_id: task.agent_id || undefined,
    task_source: task.source,
    has_source: Boolean(task.source_id),
    is_subtask: Boolean(task.parent_task_id),
    is_recurring: Boolean(task.is_recurring),
    heartbeat_enabled: Boolean(task.heartbeat_enabled),
    auto_start_agent: Boolean(task.auto_start_agent),
    auto_complete_without_review: Boolean(task.auto_complete_without_review)
  }
}

export function getTaskMutationProperties(data: Record<string, unknown>): AnalyticsProperties {
  return {
    changed_fields: Object.keys(data).filter((key) => !key.startsWith('_')).sort(),
    includes_attachments: Array.isArray(data.attachments) || Array.isArray(data._pendingFiles),
    includes_repos: Array.isArray(data.repos),
    includes_output_fields: Array.isArray(data.output_fields),
    includes_agent_assignment: Object.prototype.hasOwnProperty.call(data, 'agent_id'),
    includes_status: Object.prototype.hasOwnProperty.call(data, 'status')
  }
}

export function getAgentMessageProperties(message: {
  role?: string
  partType?: string
  tool?: { name?: string; status?: string; questions?: unknown[]; todos?: unknown[] }
  taskProgress?: { status?: string; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number } }
}): AnalyticsProperties {
  return {
    message_role: message.role,
    part_type: message.partType,
    tool_name: message.tool?.name,
    tool_status: message.tool?.status,
    question_count: message.tool?.questions?.length,
    todo_count: message.tool?.todos?.length,
    task_progress_status: message.taskProgress?.status,
    total_tokens: message.taskProgress?.usage?.total_tokens,
    tool_uses: message.taskProgress?.usage?.tool_uses,
    duration_ms: message.taskProgress?.usage?.duration_ms
  }
}

function cleanProperties(properties: AnalyticsProperties): AnalyticsProperties {
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined && value !== null && value !== '')
  )
}
