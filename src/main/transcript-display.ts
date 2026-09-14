import type { TranscriptPartRecord } from './database'
import { measureIpcMessage } from './ipc-message-size'

export const TRANSCRIPT_FIELD_CHARS = 16_000
export const TRANSCRIPT_RECORD_BYTES = 32 * 1024
export const TRANSCRIPT_PAGE_BYTES = 1024 * 1024
const NOTICE = '\n\n[Large record: only a preview is displayed. Use Export transcript to save the full record.]'

/** Presentation only. Never write these previews back to the database. */
export function transcriptDisplayPart(part: TranscriptPartRecord, clipped = false): TranscriptPartRecord {
  if (!clipped && !measureIpcMessage(part, TRANSCRIPT_RECORD_BYTES).reason) return part
  const preview: TranscriptPartRecord = {
    taskId: part.taskId, partId: part.partId, seq: part.seq,
    role: part.role, createdAt: part.createdAt, updatedAt: part.updatedAt, rev: part.rev,
    partType: 'text', content: part.content.slice(0, 8000) + NOTICE
  }
  // An invalid identity must not silently corrupt the renderer projection.
  if (measureIpcMessage(preview, TRANSCRIPT_RECORD_BYTES).reason) {
    throw new Error('Transcript record metadata is too large to display')
  }
  return preview
}
