/**
 * Words the recogniser must not treat as the user's.
 *
 * Two kinds of text reach the recogniser that nobody meant to say:
 *
 *  1. 20x's own voice. The barge-in gate holds audio back while an answer is
 *     read, but the gate works on loudness alone, and a loud passage of the
 *     answer can pass for a person talking. Then 20x's own sentence is
 *     transcribed and sent back to the agent as if the user had said it.
 *  2. Room noise. A cough, a chair or a breath comes out of the recogniser as
 *     a stray "the" or "uh", and in a conversation that is sent as a message.
 *
 * The audio checks cannot tell either of these from speech. The words can: an
 * echo repeats what was just read aloud, and noise decodes to filler.
 */

/** How long a sentence that was read aloud can still come back as an echo. */
export const ECHO_MEMORY_MS = 20_000

/** The share of words that must match what was read aloud to count as an echo. */
export const ECHO_MATCH_SHARE = 0.7

/** What noise decodes to. A sentence made only of these is never sent. */
const FILLER = new Set([
  'a', 'ah', 'an', 'and', 'eh', 'er', 'erm', 'hm', 'hmm', 'huh', 'i', 'it', 'mm', 'mhm',
  'oh', 'so', 'the', 'uh', 'uhm', 'um', 'umm'
])

/** Lower-case words, without punctuation. The small model writes in capitals. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
}

/** True when the text is only noise: nothing, or filler words. */
export function isNoise(text: string): boolean {
  const words = wordsOf(text)
  return words.every((word) => FILLER.has(word))
}

export class SpokenEcho {
  private spoken: Array<{ words: Set<string>; at: number }> = []

  /** Remembers a sentence that is being read aloud. */
  remember(text: string, now = Date.now()): void {
    const words = new Set(wordsOf(text))
    if (words.size === 0) return
    this.spoken.push({ words, at: now })
    this.prune(now)
  }

  forget(): void {
    this.spoken = []
  }

  /**
   * True when the text repeats what was read aloud in the last
   * `ECHO_MEMORY_MS`.
   *
   * A single word is never called an echo. "Yes" or "stop" is exactly what a
   * user answers with, and the answer may well have contained it.
   */
  isEcho(text: string, now = Date.now()): boolean {
    this.prune(now)
    if (this.spoken.length === 0) return false
    const words = wordsOf(text).filter((word) => !FILLER.has(word))
    if (words.length < 2) return false
    const heard = new Set<string>()
    for (const sentence of this.spoken) for (const word of sentence.words) heard.add(word)
    const matched = words.filter((word) => heard.has(word)).length
    return matched / words.length >= ECHO_MATCH_SHARE
  }

  private prune(now: number): void {
    while (this.spoken.length > 0 && now - this.spoken[0].at > ECHO_MEMORY_MS) this.spoken.shift()
  }
}

/** What this window has read aloud recently. */
export const spokenEcho = new SpokenEcho()
