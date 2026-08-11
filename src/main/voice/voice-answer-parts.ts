/**
 * Which parts of a transcript are the answer to read aloud (design §5.7).
 *
 * These are pure functions over transcript records so they can be tested
 * without starting the application.
 */

export interface TranscriptLike {
  partId?: string
  role: string
  content: string
  partType?: string
}

export interface VoiceAnswerPart {
  partId: string
  content: string
}

/**
 * Every message of an answer, in the order it was written.
 *
 * One turn can hold several. An agent says something, uses a tool, and says
 * something else: each is a message of its own and each belongs to the answer.
 * Taking only the newest one skipped the first message whenever both landed in
 * a single transcript flush.
 *
 * Tool calls, questions, errors and hidden reasoning are skipped, because
 * design §5.7 forbids speaking any of them.
 */
export function assistantTextParts(parts: TranscriptLike[]): VoiceAnswerPart[] {
  const answer: VoiceAnswerPart[] = []
  for (const part of parts) {
    if (part.role !== 'assistant') continue
    if (part.partType && part.partType !== 'text') continue
    if (!(part.content ?? '').trim()) continue
    answer.push({ partId: part.partId ?? `assistant-${answer.length}`, content: part.content })
  }
  return answer
}

/**
 * This turn only: everything written after the user last spoke.
 *
 * The stored transcript holds the whole conversation. Reading all of it would
 * replay every answer the agent has ever given on the task.
 */
export function sinceLastUserMessage(parts: TranscriptLike[]): TranscriptLike[] {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].role === 'user') return parts.slice(i + 1)
  }
  return parts
}
