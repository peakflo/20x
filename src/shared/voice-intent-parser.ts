/**
 * Deterministic voice-command parser (design §5.4).
 *
 * Rules that this file must keep:
 *  - It returns members of the closed `VoiceIntent` union only. It never
 *    returns a shell command, a SQL string, or a method name.
 *  - It never resolves a task or an agent to an ID. Main does that against the
 *    database, so a mis-heard word cannot address a record directly.
 *  - Text after "ask the agent" stays verbatim. Words inside that message are
 *    never re-read as another command.
 *  - In `dictation` mode it does not parse commands at all.
 *
 * A classifier can be added later behind the same return type. It must produce
 * the same closed union and must not lower the confirmation rules.
 */

import type {
  VoiceInterpretation,
  VoiceIntent,
  VoiceIntentProposal,
  VoicePriority,
  VoiceTargetRef,
  VoiceTurnMode,
  VoiceViewName,
} from './voice'

const WAKE_PREFIX = /^(?:hey\s+)?(?:20x|twenty\s*x|twentyx)\s*[,:]?\s*/i
const TRAILING_PUNCT = /[.!?,;\s]+$/

function normalize(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(WAKE_PREFIX, '').replace(TRAILING_PUNCT, '')
}

function currentRef(): VoiceTargetRef {
  return { kind: 'current' }
}

function titleRef(text: string): VoiceTargetRef {
  return { kind: 'title', text: text.replace(/^["']|["']$/g, '').trim() }
}

/** Splits free text into a title and an optional description on the first sentence end. */
export function splitTitleAndDescription(text: string): { title: string; description?: string } {
  const match = text.match(/^(.+?[.!?])\s+([\s\S]+)$/)
  if (!match) return { title: text.trim() }
  return { title: match[1].replace(TRAILING_PUNCT, '').trim(), description: match[2].trim() }
}

const PRIORITY_WORDS: Record<string, VoicePriority> = {
  critical: 'critical',
  urgent: 'critical',
  high: 'high',
  medium: 'medium',
  normal: 'medium',
  low: 'low',
}

/** Pulls a trailing "... with high priority" out of a spoken task title. */
export function extractPriority(text: string): { text: string; priority?: VoicePriority } {
  const match = text.match(/\s*(?:,)?\s*(?:with\s+|at\s+|as\s+)?(critical|urgent|high|medium|normal|low)\s+priority$/i)
  if (!match) return { text: text.trim() }
  return {
    text: text.slice(0, match.index).replace(TRAILING_PUNCT, '').trim(),
    priority: PRIORITY_WORDS[match[1].toLowerCase()],
  }
}

const VIEW_ALIASES: Record<string, VoiceViewName> = {
  dashboard: 'dashboard',
  home: 'dashboard',
  task: 'tasks',
  tasks: 'tasks',
  'task list': 'tasks',
  skill: 'skills',
  skills: 'skills',
  canvas: 'canvas',
  board: 'canvas',
  setting: 'settings',
  settings: 'settings',
  preferences: 'settings',
}

function propose(
  intent: VoiceIntent,
  transcript: string,
  summary: string,
  confidence = 0.95
): VoiceIntentProposal {
  return { intent, confidence, transcript, source: 'deterministic', summary }
}

interface Rule {
  pattern: RegExp
  build: (m: RegExpMatchArray, transcript: string) => VoiceIntentProposal | null
}

/**
 * Ordered rules. `reply_to_agent` comes before the action verbs so that a
 * spoken message such as "ask the agent to start the task" is delivered as a
 * message and is not executed as `start_task`.
 */
const RULES: Rule[] = [
  {
    pattern: /^(?:cancel|never\s?mind|nevermind|forget it|stop listening|abort)$/i,
    build: (_m, t) => propose({ type: 'cancel' }, t, 'Cancel', 1),
  },
  {
    pattern: /^(?:please\s+)?(?:ask|tell|reply to|respond to|say to|send to|message)\s+(?:the\s+)?agent\b\s*[,:]?\s*(.+)$/i,
    build: (m, t) =>
      propose(
        { type: 'reply_to_agent', taskRef: currentRef(), message: m[1].trim() },
        t,
        `Send to the agent: “${m[1].trim()}”`
      ),
  },
  {
    pattern: /^(?:please\s+)?(?:reply|respond)\b\s*[,:]?\s*(.+)$/i,
    build: (m, t) =>
      propose(
        { type: 'reply_to_agent', taskRef: currentRef(), message: m[1].trim() },
        t,
        `Send to the agent: “${m[1].trim()}”`
      ),
  },
  {
    pattern: /^(?:please\s+)?(?:approve|allow|accept)(?:\s+(?:this|it|that|the))?(?:\s+(?:checkpoint|request|permission|action|change|step))?$/i,
    build: (_m, t) =>
      propose({ type: 'approve_checkpoint', taskRef: currentRef() }, t, 'Approve the pending checkpoint'),
  },
  {
    pattern: /^(?:please\s+)?(?:reject|deny|decline|disallow)(?:\s+(?:this|it|that|the))?(?:\s+(?:checkpoint|request|permission|action|change|step))?$/i,
    build: (_m, t) =>
      propose({ type: 'reject_checkpoint', taskRef: currentRef() }, t, 'Reject the pending checkpoint'),
  },
  {
    pattern: /^(?:read|repeat)\s+(?:me\s+)?(?:the\s+)?(?:last|latest)\s+(?:answer|reply|response|message)$/i,
    build: (_m, t) => propose({ type: 'read_last_answer', taskRef: currentRef() }, t, 'Read the last answer'),
  },
  {
    pattern: /^(?:read|say)\s+that\s+back$/i,
    build: (_m, t) => propose({ type: 'read_last_answer', taskRef: currentRef() }, t, 'Read the last answer'),
  },
  {
    pattern: /^(?:create|add|make|new)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:task|to-?do|ticket)\b(?:\s+(?:to|for|called|named|titled|that|about|which)\b)?\s*[:,]?\s*(.+)$/i,
    build: (m, t) => {
      const withPriority = extractPriority(m[1])
      if (!withPriority.text) return null
      const split = splitTitleAndDescription(withPriority.text)
      return propose(
        {
          type: 'create_task',
          title: split.title,
          ...(split.description ? { description: split.description } : {}),
          ...(withPriority.priority ? { priority: withPriority.priority } : {}),
        },
        t,
        `Create task “${split.title}”`
      )
    },
  },
  {
    pattern: /^assign\s+(?:the\s+)?task\s+(.+?)\s+to\s+(?:the\s+)?(?:agent\s+)?(.+)$/i,
    build: (m, t) =>
      propose(
        { type: 'assign_agent', taskRef: titleRef(m[1]), agentName: m[2].trim() },
        t,
        `Assign “${m[1].trim()}” to ${m[2].trim()}`
      ),
  },
  {
    pattern: /^assign\s+(?:this|it|that|this task|the current task)?\s*to\s+(?:the\s+)?(?:agent\s+)?(.+)$/i,
    build: (m, t) =>
      propose(
        { type: 'assign_agent', taskRef: currentRef(), agentName: m[1].trim() },
        t,
        `Assign this task to ${m[1].trim()}`
      ),
  },
  {
    pattern: /^(?:start|run|begin|kick\s?off)\s+(?:the\s+)?task\s+(.+)$/i,
    build: (m, t) => propose({ type: 'start_task', taskRef: titleRef(m[1]) }, t, `Start “${m[1].trim()}”`),
  },
  {
    pattern: /^(?:start|run|begin|kick\s?off)\s+(?:this|it|that|this task|the task|the current task)$/i,
    build: (_m, t) => propose({ type: 'start_task', taskRef: currentRef() }, t, 'Start this task'),
  },
  {
    pattern: /^(?:open|show|go to|switch to|navigate to)\s+(?:the\s+)?canvas\s+for\s+(?:this|this task|the current task)$/i,
    build: (_m, t) =>
      propose({ type: 'navigate', destination: 'canvas', taskRef: currentRef() }, t, 'Open the canvas for this task'),
  },
  {
    pattern: /^(?:open|show|go to|switch to|navigate to|display)\s+(?:the\s+|my\s+)?([a-z ]+?)(?:\s+view|\s+page|\s+tab)?$/i,
    build: (m, t) => {
      const destination = VIEW_ALIASES[m[1].trim().toLowerCase()]
      if (!destination) return null
      return propose({ type: 'navigate', destination }, t, `Open ${destination}`)
    },
  },
]

/**
 * Interprets one final transcript.
 *
 * `dictation` mode always returns the words unchanged. `command` mode returns a
 * validated proposal, or `unrecognized` when no rule matches — it never guesses.
 */
export function interpretTranscript(
  transcript: string,
  mode: VoiceTurnMode = 'command'
): VoiceInterpretation {
  const text = normalize(transcript)
  if (!text) return { kind: 'unrecognized', transcript: transcript.trim() }
  // A conversation is dictation that keeps the microphone open. Only the
  // command mode may reach the rules below — anything else would let words
  // meant for an agent run a task action, and would reject the tail of a
  // conversation as a bad command instead of writing it into the box.
  if (mode === 'dictation' || mode === 'conversation') {
    return { kind: 'dictation', text: transcript.trim() }
  }

  for (const rule of RULES) {
    const match = text.match(rule.pattern)
    if (!match) continue
    const proposal = rule.build(match, text)
    if (proposal) return { kind: 'intent', proposal }
  }
  return { kind: 'unrecognized', transcript: text }
}

/** Structural guard used before any action runs. Rejects anything off-schema. */
export function isVoiceIntent(value: unknown): value is VoiceIntent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const isRef = (r: unknown): boolean => {
    if (!r || typeof r !== 'object') return false
    const ref = r as Record<string, unknown>
    if (ref.kind === 'current') return true
    if (ref.kind === 'title') return typeof ref.text === 'string' && ref.text.length > 0
    if (ref.kind === 'id') return typeof ref.id === 'string' && ref.id.length > 0
    return false
  }
  const isText = (s: unknown): boolean => typeof s === 'string' && s.trim().length > 0

  switch (v.type) {
    case 'create_task':
      return (
        isText(v.title) &&
        (v.description === undefined || typeof v.description === 'string') &&
        (v.priority === undefined ||
          (typeof v.priority === 'string' && ['critical', 'high', 'medium', 'low'].includes(v.priority)))
      )
    case 'assign_agent':
      return isRef(v.taskRef) && isText(v.agentName)
    case 'start_task':
    case 'read_last_answer':
      return isRef(v.taskRef)
    case 'reply_to_agent':
      return isRef(v.taskRef) && isText(v.message)
    case 'approve_checkpoint':
    case 'reject_checkpoint':
      return isRef(v.taskRef) && (v.message === undefined || typeof v.message === 'string')
    case 'navigate':
      return (
        typeof v.destination === 'string' &&
        ['tasks', 'skills', 'dashboard', 'canvas', 'settings'].includes(v.destination) &&
        (v.taskRef === undefined || isRef(v.taskRef))
      )
    case 'cancel':
      return true
    default:
      return false
  }
}
