/**
 * Test-only stand-in for the main process side of the transcript stream: an
 * in-memory durable transcript plus the REAL TranscriptDeltaEncoder, so store
 * tests exercise the same events and resync answers the app produces.
 */
import {
  TranscriptDeltaEncoder,
  type TranscriptDeltaEvent,
  type TranscriptPartLike,
  type TranscriptSyncResult
} from './transcript-stream'

export interface FakeTranscriptWrite {
  partId: string
  content?: string
  role?: string
  partType?: string
  tool?: unknown
  payload?: unknown
  createdAt?: number
}

export class FakeTranscriptServer {
  encoder: TranscriptDeltaEncoder
  private readonly tasks = new Map<string, Map<string, TranscriptPartLike>>()
  private rev = 0
  private clock = 1_000

  constructor(epoch = 'epoch-1') {
    this.encoder = new TranscriptDeltaEncoder({ epoch })
  }

  /** Simulate a main-process restart: new epoch, seq restarts, nothing remembered. */
  restart(epoch: string): void {
    this.encoder = new TranscriptDeltaEncoder({ epoch })
  }

  /** Upsert parts and return the event the app would push for this flush. */
  write(taskId: string, writes: FakeTranscriptWrite[]): TranscriptDeltaEvent {
    const task = this.tasks.get(taskId) ?? new Map<string, TranscriptPartLike>()
    this.tasks.set(taskId, task)
    const changed: TranscriptPartLike[] = []
    for (const w of writes) {
      const prev = task.get(w.partId)
      this.rev += 1
      this.clock += 1
      const next: TranscriptPartLike = {
        taskId,
        partId: w.partId,
        seq: prev?.seq ?? task.size + 1,
        role: w.role ?? prev?.role ?? 'assistant',
        content: w.content ?? prev?.content ?? '',
        partType: w.partType ?? prev?.partType ?? 'text',
        tool: w.tool ?? prev?.tool,
        payload: w.payload ?? prev?.payload,
        createdAt: prev?.createdAt ?? w.createdAt ?? this.clock,
        updatedAt: this.clock,
        rev: this.rev
      }
      task.set(w.partId, next)
      changed.push(next)
    }
    return this.encoder.encode(taskId, changed, this.maxRev(taskId))
  }

  /** The resync answer (whole transcript when sinceRev is undefined). */
  sync(taskId: string, sinceRev?: number): TranscriptSyncResult {
    const all = [...(this.tasks.get(taskId)?.values() ?? [])].sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))
    const full = typeof sinceRev !== 'number'
    return {
      taskId,
      epoch: this.encoder.epoch,
      seq: this.encoder.currentSeq(taskId),
      maxRev: this.maxRev(taskId),
      full,
      parts: full ? all : all.filter((p) => p.rev > sinceRev)
    }
  }

  parts(taskId: string): TranscriptPartLike[] {
    return this.sync(taskId).parts
  }

  private maxRev(taskId: string): number {
    let max = 0
    for (const p of this.tasks.get(taskId)?.values() ?? []) max = Math.max(max, p.rev)
    return max
  }
}
