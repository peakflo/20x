/**
 * Transcript delta stream — one protocol for the desktop window (IPC) and the
 * mobile client (WebSocket).
 *
 * The main process owns the durable transcript (`transcript_parts`). While an
 * agent streams, the same part (the answer being written) is rewritten every
 * flush. Sending the whole part each time makes the bytes on the wire grow with
 * the square of the answer length, so the sender instead diffs each changed
 * part against what it last sent and emits:
 *
 *   - `append`: text added to the end of a part whose other fields did not change
 *               (`at` is the content length the receiver must have);
 *   - `put`:    the whole part (a new part, or a replacement of an existing one:
 *               edits/rewrites of earlier parts, tool status changes, …).
 *
 * Every event carries a per-task `seq` (contiguous within one sender `epoch`).
 * A receiver applies an event only when `seq === lastSeq + 1` for that task.
 * Stale events (`seq <= lastSeq`) are dropped. Anything else — a gap, an
 * unknown task, a new epoch (main process restarted), or an `append` whose
 * `at` does not match the local content — makes the receiver pull a resync
 * (`TranscriptSyncResult`) and buffer events until it lands. Full snapshots are
 * pulled by the one receiver that needs them, never broadcast to every client.
 */

/** Durable transcript part, as stored by the main process. */
export interface TranscriptPartLike {
  taskId: string
  partId: string
  seq: number
  role: string
  content: string
  partType?: string
  tool?: unknown
  payload?: unknown
  createdAt: number
  updatedAt: number
  rev: number
}

export interface TranscriptPutOp<P extends TranscriptPartLike = TranscriptPartLike> {
  op: 'put'
  part: P
}

export interface TranscriptAppendOp {
  op: 'append'
  partId: string
  /** Content length the receiver must hold before appending. */
  at: number
  text: string
  rev: number
  updatedAt: number
}

export type TranscriptOp<P extends TranscriptPartLike = TranscriptPartLike> = TranscriptPutOp<P> | TranscriptAppendOp

/** Payload of the `transcript:changed` push (desktop IPC and mobile WS). */
export interface TranscriptDeltaEvent<P extends TranscriptPartLike = TranscriptPartLike> {
  taskId: string
  /** Identifies one sender lifetime; a new epoch means seq restarted. */
  epoch: string
  /** Per-task stream position, contiguous within an epoch. */
  seq: number
  /** Highest durable rev for the task after this event (catch-up cursor). */
  maxRev: number
  ops: TranscriptOp<P>[]
}

/**
 * Answer to a resync request. `seq` is the stream position the parts are
 * consistent with: the sender flushes pending changes before reading, so the
 * next event the receiver can apply is `seq + 1`.
 */
export interface TranscriptSyncResult<P extends TranscriptPartLike = TranscriptPartLike> {
  taskId: string
  epoch: string
  seq: number
  maxRev: number
  /** true: `parts` is the whole transcript; false: parts changed since `sinceRev`. */
  full: boolean
  parts: P[]
}

// ── Sender ──────────────────────────────────────────────────────────────────

interface BaselineEntry {
  content: string
  /** Every field except content/rev/updatedAt; an append requires it unchanged. */
  meta: string
}

function partMeta(p: TranscriptPartLike): string {
  return JSON.stringify([p.role, p.partType ?? null, p.tool ?? null, p.payload ?? null, p.createdAt, p.seq])
}

export interface TranscriptDeltaEncoderOptions {
  epoch?: string
  /** Tasks whose last-sent parts are remembered (LRU). */
  maxTasks?: number
  /** Parts remembered per task (LRU). A forgotten part is sent with `put`. */
  maxPartsPerTask?: number
}

/**
 * Sender side: turns "these parts changed" into the smallest safe ops, keeping
 * a bounded memory of what was last sent per part. Forgetting is always safe:
 * a part without a baseline is sent whole.
 */
export class TranscriptDeltaEncoder {
  readonly epoch: string
  private readonly maxTasks: number
  private readonly maxPartsPerTask: number
  private readonly seqByTask = new Map<string, number>()
  private readonly baselines = new Map<string, Map<string, BaselineEntry>>()

  constructor(options: TranscriptDeltaEncoderOptions = {}) {
    this.epoch = options.epoch ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    this.maxTasks = options.maxTasks ?? 64
    this.maxPartsPerTask = options.maxPartsPerTask ?? 256
  }

  /** Stream position of the last event emitted for a task (0 before any). */
  currentSeq(taskId: string): number {
    return this.seqByTask.get(taskId) ?? 0
  }

  /** Build the next event for a task from the full records of its changed parts. */
  encode<P extends TranscriptPartLike>(taskId: string, parts: P[], maxRev: number): TranscriptDeltaEvent<P> {
    const baseline = this.baselineFor(taskId)
    const ops: TranscriptOp<P>[] = []
    for (const part of parts) {
      ops.push(this.diffPart(baseline, part))
      baseline.delete(part.partId)
      baseline.set(part.partId, { content: part.content, meta: partMeta(part) })
      if (baseline.size > this.maxPartsPerTask) {
        const oldest = baseline.keys().next().value
        if (oldest !== undefined) baseline.delete(oldest)
      }
    }
    const seq = this.currentSeq(taskId) + 1
    this.seqByTask.set(taskId, seq)
    return { taskId, epoch: this.epoch, seq, maxRev, ops }
  }

  /** Drop the remembered parts of a task (its next changes are sent whole). */
  forgetTask(taskId: string): void {
    this.baselines.delete(taskId)
  }

  private diffPart<P extends TranscriptPartLike>(baseline: Map<string, BaselineEntry>, part: P): TranscriptOp<P> {
    const prev = baseline.get(part.partId)
    // Append only when it is exact: same metadata and the new content extends
    // the old one. Rewrites, truncations and tool/status changes go whole.
    if (prev && prev.meta === partMeta(part) && part.content.startsWith(prev.content)) {
      return {
        op: 'append',
        partId: part.partId,
        at: prev.content.length,
        text: part.content.slice(prev.content.length),
        rev: part.rev,
        updatedAt: part.updatedAt
      }
    }
    return { op: 'put', part }
  }

  private baselineFor(taskId: string): Map<string, BaselineEntry> {
    let baseline = this.baselines.get(taskId)
    if (baseline) {
      // Touch for LRU.
      this.baselines.delete(taskId)
    } else {
      baseline = new Map()
    }
    this.baselines.set(taskId, baseline)
    while (this.baselines.size > this.maxTasks) {
      const oldest = this.baselines.keys().next().value
      if (oldest === undefined) break
      this.baselines.delete(oldest)
    }
    return baseline
  }
}

// ── Receiver ────────────────────────────────────────────────────────────────

/** Store hooks the receiver drives. */
export interface TranscriptReceiverHost<P extends TranscriptPartLike> {
  /** True when the store keeps this task's transcript live. Others are ignored. */
  isTracked(taskId: string): boolean
  getPart(taskId: string, partId: string): P | undefined
  /** Highest rev the store has applied for the task (catch-up cursor). */
  getRev(taskId: string): number
  /** Upsert full records (changed parts of an applied event or a catch-up). */
  commit(taskId: string, parts: P[], maxRev: number): void
  /** Replace the whole transcript. Return false to decline (view went away). */
  replace(taskId: string, parts: P[], maxRev: number): boolean
  /** Pull a resync: the whole transcript when `sinceRev` is undefined. */
  fetchSync(taskId: string, sinceRev: number | undefined): Promise<TranscriptSyncResult<P>>
}

/** What happened to one incoming event. */
export type TranscriptReceiveResult = 'applied' | 'stale' | 'ignored' | 'resyncing'

/** Rebuild the full records an event changes; null when an append does not fit. */
export function applyTranscriptOps<P extends TranscriptPartLike>(
  ops: TranscriptOp<P>[],
  getPart: (partId: string) => P | undefined
): P[] | null {
  const changed = new Map<string, P>()
  for (const op of ops) {
    if (op.op === 'put') {
      changed.set(op.part.partId, op.part)
      continue
    }
    const current = changed.get(op.partId) ?? getPart(op.partId)
    if (!current || current.content.length !== op.at) return null
    changed.set(op.partId, {
      ...current,
      content: op.text.length > 0 ? current.content + op.text : current.content,
      rev: op.rev,
      updatedAt: op.updatedAt
    })
  }
  return [...changed.values()]
}

interface StreamPosition {
  epoch: string
  seq: number
}

/**
 * Receiver side, shared by the desktop and mobile stores: seq/epoch tracking,
 * stale drop, gap → resync, buffering while a resync is in flight.
 */
export class TranscriptStreamReceiver<P extends TranscriptPartLike> {
  private readonly positions = new Map<string, StreamPosition>()
  private readonly inFlight = new Map<string, { promise: Promise<void>; buffer: TranscriptDeltaEvent<P>[] }>()

  constructor(private readonly host: TranscriptReceiverHost<P>) {}

  /** Stream position the store is at for a task (undefined when not synced). */
  position(taskId: string): { epoch: string; seq: number } | undefined {
    return this.positions.get(taskId)
  }

  isResyncing(taskId: string): boolean {
    return this.inFlight.has(taskId)
  }

  handle(event: TranscriptDeltaEvent<P>): TranscriptReceiveResult {
    const { taskId } = event
    // Untracked tasks keep their last position, so a store that stops following
    // a task (view unmounted) can catch up by rev when it follows it again.
    if (!this.host.isTracked(taskId)) return 'ignored'
    const pending = this.inFlight.get(taskId)
    if (pending) {
      pending.buffer.push(event)
      return 'resyncing'
    }
    const position = this.positions.get(taskId)
    if (!position || position.epoch !== event.epoch) {
      // Never synced, or the sender restarted: only a whole transcript is safe.
      void this.resync(taskId, { full: true, buffered: [event] })
      return 'resyncing'
    }
    if (event.seq <= position.seq) return 'stale'
    if (event.seq !== position.seq + 1) {
      // Missed at least one event: catch up on everything changed since our rev.
      void this.resync(taskId, { full: false, buffered: [event] })
      return 'resyncing'
    }
    const changed = applyTranscriptOps(event.ops, (partId) => this.host.getPart(taskId, partId))
    if (!changed) {
      // Local content diverged from what the sender diffed against.
      void this.resync(taskId, { full: true, buffered: [event] })
      return 'resyncing'
    }
    position.seq = event.seq
    this.host.commit(taskId, changed, event.maxRev)
    return 'applied'
  }

  /**
   * Pull a resync. `full: true` replaces the transcript; otherwise only parts
   * changed since the store's rev are fetched. Concurrent calls share one
   * request. Events arriving meanwhile are buffered and replayed afterwards.
   */
  resync(taskId: string, options: { full: boolean; buffered?: TranscriptDeltaEvent<P>[] }): Promise<void> {
    const existing = this.inFlight.get(taskId)
    if (existing) {
      if (options.buffered) existing.buffer.push(...options.buffered)
      return existing.promise
    }
    const buffer: TranscriptDeltaEvent<P>[] = [...(options.buffered ?? [])]
    const full = options.full || !this.positions.has(taskId)
    const promise = (async () => {
      let accepted = false
      try {
        const result = await this.host.fetchSync(taskId, full ? undefined : this.host.getRev(taskId))
        if (result.full) {
          accepted = this.host.replace(taskId, result.parts, result.maxRev)
        } else if (this.host.isTracked(taskId)) {
          this.host.commit(taskId, result.parts, result.maxRev)
          accepted = true
        }
        if (accepted) this.positions.set(taskId, { epoch: result.epoch, seq: result.seq })
        else this.positions.delete(taskId)
      } catch (err) {
        this.positions.delete(taskId)
        console.error(`[transcript-stream] resync failed for task ${taskId}:`, err)
      } finally {
        this.inFlight.delete(taskId)
      }
      if (!accepted) return
      // Replay what arrived meanwhile, in order; stale ones are dropped.
      buffer.sort((a, b) => a.seq - b.seq)
      for (const event of buffer) {
        const result = this.handle(event)
        if (result === 'resyncing') {
          // A later event still has a gap; it started a new resync and the
          // remaining buffered events belong to that one.
          const next = this.inFlight.get(taskId)
          if (next) next.buffer.push(...buffer.slice(buffer.indexOf(event) + 1))
          break
        }
      }
    })()
    this.inFlight.set(taskId, { promise, buffer })
    return promise
  }

  /** Forget a task's stream position (its next event triggers a full resync). */
  forget(taskId: string): void {
    this.positions.delete(taskId)
  }

  /** Forget every stream position (e.g. after a WebSocket reconnect). */
  forgetAll(): void {
    this.positions.clear()
  }
}
