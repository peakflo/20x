export interface TranscriptPage<T> {
  parts: T[]
  maxRev: number
  afterSeq: number
  hasMore: boolean
}

/** Each IPC reply is bounded. Keep one revision watermark across all pages. */
export async function collectTranscriptPages<T>(
  read: (cursor?: { afterSeq: number; maxRev: number }) => Promise<TranscriptPage<T>>
): Promise<{ parts: T[]; maxRev: number }> {
  const parts: T[] = []
  let cursor: { afterSeq: number; maxRev: number } | undefined
  while (true) {
    const page = await read(cursor)
    parts.push(...page.parts)
    if (!page.hasMore) return { parts, maxRev: page.maxRev }
    if (cursor && page.afterSeq <= cursor.afterSeq) throw new Error('Transcript page did not advance')
    cursor = { afterSeq: page.afterSeq, maxRev: page.maxRev }
  }
}
