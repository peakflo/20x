/**
 * Agent activity blocks: one collapsible block per agent turn.
 *
 * Ported from the workflow-builder transcript (`lib/coding-agents/activity-blocks.ts`).
 * A turn's tool calls, thinking, todo updates, subagent progress and in-between
 * notes fold into ONE block that sits where the turn's first activity happened.
 * Everything a person must see or act on stays outside: user messages, the
 * final answer, question cards, plan reviews, errors and retries, system
 * notices and subtask notifications.
 *
 * TURN BOUNDARIES: 20x transcripts carry no turn markers, so a turn is
 * everything between two user messages.
 *
 * NOTES: an assistant text part is a note (inside the block) when the same turn
 * does more work after it. Text with nothing after it in its turn is a reply and
 * stays outside, so a streaming answer is never hidden. While a turn runs, the
 * latest note is its live summary.
 *
 * Desktop (`AgentTranscriptPanel`) and mobile (`ConversationPage`) both use this
 * module, so the grouping rules are identical on both.
 */

/** The parts of a transcript message this module reads. */
export interface ActivityMessageLike {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  partType?: string
  tool?: {
    name: string
    status?: string
    error?: string
    output?: string
    questions?: unknown[]
    todos?: unknown[]
  }
}

/** Where a part belongs. `text` is an assistant reply-or-note; see above. */
export type ActivityPartClass = 'activity' | 'outside' | 'text'

export interface ActivityBlock<M extends ActivityMessageLike = ActivityMessageLike> {
  /** Stable for the life of the turn: `activity:<turnKey>`. */
  id: string
  /** Steps in transcript order: tools, thinking, todos, subagents and notes. */
  messages: M[]
  /** Ids of the text parts that are notes. */
  noteIds: ReadonlySet<string>
  startedAtMs: number
  /** The last activity or text written in the turn. */
  endedAtMs: number
}

export type ActivityTranscriptItem<M extends ActivityMessageLike = ActivityMessageLike> =
  | { type: 'message'; key: string; message: M }
  | { type: 'activity'; key: string; block: ActivityBlock<M> }

/** Markers the stores absorb; they render nothing and never form a block. */
const HIDDEN_PART_TYPES = new Set(['step-start', 'step-finish', 'system-status'])

/** Part types that always stay visible outside a block. */
const OUTSIDE_PART_TYPES = new Set(['question', 'planreview', 'error', 'retry', 'task-notification'])

/**
 * Which block a part belongs to. Mirrors the dispatch in the transcript
 * renderers: a card a person reads or acts on stays outside.
 */
export function classifyActivityPart(message: ActivityMessageLike): ActivityPartClass {
  if (message.role === 'user') return 'outside'
  const partType = message.partType
  if (partType && HIDDEN_PART_TYPES.has(partType)) return 'outside'
  // Questions are detected by content: mobile may receive them as `tool`.
  if (message.tool?.questions && message.tool.questions.length > 0) return 'outside'
  if (partType && OUTSIDE_PART_TYPES.has(partType)) return 'outside'
  if (partType === 'reasoning') return 'activity'
  if (partType === 'task_progress') return 'activity'
  if (message.tool?.todos && message.tool.todos.length > 0) return 'activity'
  if (message.tool?.name && (partType === 'tool' || partType === 'todowrite')) return 'activity'
  if (message.role === 'assistant' && (!partType || partType === 'text')) return 'text'
  return 'outside'
}

function timeOf(message: ActivityMessageLike): number {
  const at = message.timestamp instanceof Date ? message.timestamp.getTime() : Number.NaN
  return Number.isFinite(at) ? at : 0
}

/**
 * Fold a transcript into messages and activity blocks.
 *
 * Keys are stable as a turn streams: a block is keyed by its turn (the user
 * message that started it), never by its length, so the virtualizer keeps its
 * measurement and the block keeps its open state.
 */
export function groupActivity<M extends ActivityMessageLike>(
  messages: readonly M[],
  classify: (message: M) => ActivityPartClass = classifyActivityPart
): ActivityTranscriptItem<M>[] {
  const keys: string[] = []
  const classes: ActivityPartClass[] = []
  const lastActivity = new Map<string, number>()
  const endedAt = new Map<string, number>()
  let turn = 'initial'

  messages.forEach((message, index) => {
    if (message.role === 'user') turn = message.id
    const kind = message.role === 'user' ? 'outside' : classify(message)
    keys.push(turn)
    classes.push(kind)
    if (kind === 'activity') lastActivity.set(turn, index)
    // The turn's work ends at its last step or text. A card answered later
    // must not stretch "Worked for".
    if (kind === 'activity' || kind === 'text') {
      const at = timeOf(message)
      endedAt.set(turn, Math.max(endedAt.get(turn) ?? at, at))
    }
  })

  const items: ActivityTranscriptItem<M>[] = []
  const blocks = new Map<string, ActivityBlock<M> & { noteIds: Set<string> }>()
  messages.forEach((message, index) => {
    const key = keys[index]
    const kind = classes[index]
    const note = kind === 'text' && Boolean(message.content?.trim()) && index < (lastActivity.get(key) ?? -1)
    if (kind !== 'activity' && !note) {
      items.push({ type: 'message', key: message.id, message })
      return
    }
    let block = blocks.get(key)
    if (!block) {
      block = {
        id: `activity:${key}`,
        messages: [],
        noteIds: new Set(),
        startedAtMs: timeOf(message),
        endedAtMs: endedAt.get(key) ?? timeOf(message)
      }
      blocks.set(key, block)
      items.push({ type: 'activity', key: block.id, block })
    }
    block.messages.push(message)
    if (note) block.noteIds.add(message.id)
  })
  return items
}

/** The id of the last activity block, which is the live one while the agent works. */
export function lastActivityBlockId(items: readonly ActivityTranscriptItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.type === 'activity') return item.key
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Step status                                                                 */
/* -------------------------------------------------------------------------- */

export function isRunningTool(message: ActivityMessageLike): boolean {
  if (!message.tool) return false
  const s = (message.tool.status || '').toLowerCase()
  return s === '' || s === 'in_progress' || s === 'running' || s === 'pending'
}

export function isFailedTool(message: ActivityMessageLike): boolean {
  if (!message.tool) return false
  const s = (message.tool.status || '').toLowerCase()
  return s === 'error' || s === 'failed'
}

/** Tool calls that count as steps: no plan updates, no thinking, no notes. */
export function blockSteps<M extends ActivityMessageLike>(block: ActivityBlock<M>): M[] {
  return block.messages.filter(
    (m) => m.partType !== 'reasoning' && Boolean(m.tool?.name) && !(m.tool?.todos && m.tool.todos.length > 0)
  )
}

/**
 * The failure the block is still stuck on, or null. Only the latest settled
 * step counts: once any later call succeeds, the agent has moved on. The
 * failed step keeps its error icon inside the block.
 */
export function unrecoveredFailure<M extends ActivityMessageLike>(block: ActivityBlock<M>): M | null {
  const steps = blockSteps(block)
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (isRunningTool(steps[i])) continue
    return isFailedTool(steps[i]) ? steps[i] : null
  }
  return null
}

export function failureSummary(message: ActivityMessageLike): string {
  const raw = message.tool?.error?.trim() || message.tool?.output?.trim() || 'The call failed.'
  const firstLine = raw.split('\n').find((line) => line.trim()) ?? raw
  return `${message.tool?.name ?? 'Tool'}: ${firstLine.replace(/^error\s*:\s*/i, '')}`
}

/* -------------------------------------------------------------------------- */
/* Summary text                                                                */
/* -------------------------------------------------------------------------- */

export type StepFamily = 'read' | 'edit' | 'command' | 'search' | 'web' | 'browser' | 'tool'

/** Order of families when counts tie. `tool` (anything else) comes last. */
const FAMILY_ORDER: StepFamily[] = ['read', 'edit', 'command', 'search', 'web', 'browser', 'tool']

const FAMILY_RULES: Array<[RegExp, StepFamily]> = [
  [/^(read|read_file|view|cat)$/, 'read'],
  [/^(edit|multiedit|write|write_file|notebookedit|apply_patch|patch|str_replace\w*)$/, 'edit'],
  [/^(bash|shell|exec|exec_command|run_command|command|terminal)$/, 'command'],
  [/^(grep|glob|search|find|ls|list|codebase_search)$/, 'search'],
  [/^(webfetch|web_fetch|websearch|web_search|fetch)$/, 'web'],
  [/^browser_/, 'browser']
]

const NOUNS: Record<StepFamily, [string, string]> = {
  read: ['file read', 'file reads'],
  edit: ['file edit', 'file edits'],
  command: ['command', 'commands'],
  search: ['search', 'searches'],
  web: ['web request', 'web requests'],
  browser: ['browser action', 'browser actions'],
  tool: ['other call', 'other calls']
}

export function stepFamily(message: ActivityMessageLike): StepFamily {
  // MCP tools arrive as `mcp__<server>__<tool>`; classify by the tool itself.
  const name = (message.tool?.name ?? '').toLowerCase().replace(/^mcp__.+?__/, '')
  return FAMILY_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? 'tool'
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** `42s`, `1m 12s`, `1h 3m`. */
export function formatActivityDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    const seconds = total % 60
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** `0:42`, `12:05`, `1:02:05`: the running clock. */
export function formatActivityClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}:${seconds}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
}

/**
 * "12 steps · 5 file reads · 3 commands": the largest families first, at most
 * three. With one family it replaces the step count.
 */
export function stepCountsText(steps: readonly ActivityMessageLike[]): string {
  if (steps.length === 0) return ''
  const counts = new Map<StepFamily, number>()
  for (const step of steps) {
    const family = stepFamily(step)
    counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || FAMILY_ORDER.indexOf(a[0]) - FAMILY_ORDER.indexOf(b[0])
  )
  const total = plural(steps.length, 'step', 'steps')
  if (ranked.length === 1) {
    const [family, n] = ranked[0]
    return family === 'tool' ? total : plural(n, ...NOUNS[family])
  }
  const named = ranked
    .filter(([family]) => family !== 'tool')
    .slice(0, 3)
    .map(([family, n]) => plural(n, ...NOUNS[family]))
  return [total, ...named].join(' · ')
}

/** First non-empty line of a note, without markdown markers. */
export function noteSummary(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}

/**
 * The block header's one line.
 *
 * Running: the latest note (or "Working…"), the steps so far, and a clock the
 * caller ticks. Done: "Worked for 1m 12s", then the counts. A duration under a
 * second is not shown.
 */
export function blockSummary(
  block: ActivityBlock,
  state: { running: boolean; nowMs?: number }
): { title: string; detail: string; elapsed: string | null } {
  const steps = blockSteps(block)
  if (state.running) {
    const latestNote = [...block.messages].reverse().find((m) => block.noteIds.has(m.id))
    const title = latestNote ? noteSummary(latestNote.content) : ''
    const elapsedMs = (state.nowMs ?? Date.now()) - block.startedAtMs
    return {
      title: title || 'Working…',
      detail: steps.length ? `${plural(steps.length, 'step', 'steps')} so far` : '',
      elapsed: elapsedMs >= 1000 ? formatActivityClock(elapsedMs) : null
    }
  }
  const durationMs = block.endedAtMs - block.startedAtMs
  return {
    title: durationMs >= 1000 ? `Worked for ${formatActivityDuration(durationMs)}` : 'Worked',
    detail: stepCountsText(steps),
    elapsed: null
  }
}
