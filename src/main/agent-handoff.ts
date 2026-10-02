/**
 * Building a recap when a task's work hands off from one agent to another
 * mid-conversation (e.g. switching from a model that ran out of credits to
 * a different one) — a pure function over transcript records so it can be
 * tested without starting the application.
 */

export interface TranscriptLike {
  partId?: string
  role: string
  content: string
  partType?: string
}

// ~200k tokens is the smallest context window among the agent backends this
// app supports — generous enough that almost every real conversation passes
// through whole, while still being a hard ceiling so a genuinely extreme
// transcript (a long-running task looping for days) can't blow past what any
// of them can even accept. There's no way to raise this per-handoff further
// than the receiving model's own context window actually allows — beyond
// that the API call itself would reject it, recap or not.
const DEFAULT_MAX_CHARS = 800_000

/**
 * Turns a task's transcript into a recap block to seed the next agent's
 * first prompt with, instead of starting from a blank slate.
 *
 * Only user asks and the previous agent's plain text replies are kept — tool
 * calls, reasoning, questions and errors are noise for a handoff and would
 * burn context without adding anything the new agent needs to continue the
 * work. The full conversation is passed through as long as it fits under
 * maxChars; only a transcript that exceeds it gets truncated to its most
 * recent portion. Returns '' when there is nothing worth recapping (fresh
 * task, or a transcript made up entirely of skipped part types).
 */
export function buildAgentSwitchRecap(parts: TranscriptLike[], maxChars = DEFAULT_MAX_CHARS): string {
  const turns = parts.filter(
    (p) =>
      (p.role === 'user' || p.role === 'assistant') &&
      (!p.partType || p.partType === 'text') &&
      (p.content ?? '').trim().length > 0
  )
  if (turns.length === 0) return ''

  let text = turns
    .map((p) => `${p.role === 'user' ? 'User' : 'Previous agent'}: ${p.content.trim()}`)
    .join('\n\n')

  // Keep the tail on truncation — the most recent exchanges matter most for
  // picking work back up, more than how the conversation started.
  if (text.length > maxChars) {
    text = `…(earlier conversation omitted)…\n\n${text.slice(text.length - maxChars)}`
  }

  return text
}
