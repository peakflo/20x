export const PUSH_EVENTS = ['finished', 'failed', 'approval', 'question'] as const
export type PushEvent = typeof PUSH_EVENTS[number]
export type PushPreferences = Record<PushEvent, boolean>

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  finished: true, failed: true, approval: true, question: true
}

export function parsePushPreferences(value: string | undefined): PushPreferences {
  try {
    const parsed = JSON.parse(value || '{}') as Partial<PushPreferences>
    return Object.fromEntries(PUSH_EVENTS.map(event => [event, parsed[event] !== false])) as PushPreferences
  } catch {
    return { ...DEFAULT_PUSH_PREFERENCES }
  }
}

export function pushEventForStatus(previous: string | undefined, current: string): PushEvent | null {
  if (previous !== 'working') return null
  if (current === 'idle') return 'finished'
  if (current === 'error') return 'failed'
  if (current === 'waiting_approval') return 'approval'
  return null
}

export function buildPushPayload(event: PushEvent, taskId: string, taskTitle: string) {
  const body: Record<PushEvent, string> = {
    finished: 'Agent finished. Ready for review.',
    failed: 'Agent run failed. Open the conversation for details.',
    approval: 'Agent needs your approval.',
    question: 'Agent has a question for you.'
  }
  return { title: taskTitle || '20x task', body: body[event], url: taskId ? `/?conversation=${encodeURIComponent(taskId)}` : '/', tag: `task-${taskId}-${event}` }
}
