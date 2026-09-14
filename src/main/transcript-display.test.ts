import { describe, it, expect } from 'vitest'
import { transcriptDisplayPart, TRANSCRIPT_RECORD_BYTES } from './transcript-display'
import { measureIpcMessage } from './ipc-message-size'
import { collectTranscriptPages } from '../shared/transcript-pages'

describe('transcript display transport', () => {
  it('retains normal tool records and bounds large live records', () => {
    const part = { taskId: 't', partId: 'p', seq: 1, role: 'assistant', content: 'ok', rev: 1, createdAt: 1, updatedAt: 1, tool: { name: 'Read' } }
    expect(transcriptDisplayPart(part)).toBe(part)
    const large = { ...part, content: 'x'.repeat(5 * 1024 * 1024) }
    const preview = transcriptDisplayPart(large)
    expect(preview.content).toContain('Export transcript')
    expect(preview.rev).toBe(1)
    expect(preview.partId).toBe('p')
    expect(preview.tool).toBeUndefined()
    expect(measureIpcMessage(preview, TRANSCRIPT_RECORD_BYTES).reason).toBeUndefined()
    expect(large.content.length).toBe(5 * 1024 * 1024)
  })

  it('carries the fixed revision watermark across pages', async () => {
    const cursors: unknown[] = []
    const result = await collectTranscriptPages(async cursor => {
      cursors.push(cursor)
      return cursor
        ? { parts: ['second'], afterSeq: 2, maxRev: 7, hasMore: false }
        : { parts: ['first'], afterSeq: 1, maxRev: 7, hasMore: true }
    })
    expect(cursors).toEqual([undefined, { afterSeq: 1, maxRev: 7 }])
    expect(result).toEqual({ parts: ['first', 'second'], maxRev: 7 })
  })

  it('fails a stalled page scan instead of looping indefinitely', async () => {
    await expect(collectTranscriptPages(async () => ({ parts: [], afterSeq: 0, maxRev: 1, hasMore: true }))).rejects.toThrow('did not advance')
  })
})
