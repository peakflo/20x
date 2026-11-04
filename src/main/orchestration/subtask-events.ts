/**
 * In-process event bus for subtask progress.
 *
 * Replaces polling SQLite every couple of seconds (the old `wait_for_subtasks`
 * shape) with a plain subscribe: every place that already changes a subtask's
 * status, closes its run, or raises a question for its parent emits one event
 * here, and `wait_for_subtasks` (see task-api-server.ts) resolves its promise
 * the moment a matching event arrives instead of re-reading the database on a
 * timer.
 *
 * Every event carries a monotonically increasing `seq`. A caller that reads
 * the current DB state, remembers the last `seq` it observed, then subscribes
 * starting strictly after that `seq` cannot miss an event that lands in the
 * gap between the read and the subscribe — the classic check-then-subscribe
 * race. `sinceSeq` on `subscribe` exists for exactly that: replay anything
 * already buffered at or after the requested sequence before new events
 * arrive live.
 *
 * Kept deliberately tiny (plain EventEmitter + a ring buffer) — this is a
 * same-process notification channel, not a durable log. Nothing here needs to
 * survive a restart: a restart means every in-flight `wait_for_subtasks` call
 * died with the process anyway, and the caller re-subscribes against current
 * DB state on its next call.
 */

import { EventEmitter } from 'events'

export type SubtaskEventKind = 'status' | 'run_end' | 'child_question'

export interface SubtaskEvent {
  /** Monotonically increasing, process-lifetime-only sequence number. */
  seq: number
  at: number
  kind: SubtaskEventKind
  parentTaskId: string
  childTaskId: string
  /** Task status after the transition (kind: 'status'). */
  status?: string
  /** Honest run-end reason (kind: 'run_end') — see run-finalization.ts's RunEndReason. Kept as a plain string here so this bus never has to be rebuilt when that enum changes. */
  endReason?: string
  /** Present for kind: 'child_question' — the question/approval raised. */
  questionId?: string
  /** True when the end reason or child question needs a human/parent's attention rather than being routine progress. */
  needsAttention?: boolean
}

const RING_BUFFER_SIZE = 500

/**
 * Tracks the last event that affects each subtask tree, so a caller that read
 * DB state as of `sinceSeq` can ask "did anything happen after that?" without
 * replaying the whole buffer. Kept as a ring buffer scoped to the whole bus:
 * since one process serves many parents, and `wait_for_subtasks` calls are
 * rare relative to typical traffic, a single shared buffer is simpler and
 * cheap enough.
 */
export class SubtaskEventBus extends EventEmitter {
  private seqCounter = 0
  private readonly buffer: SubtaskEvent[] = []

  constructor() {
    // Many concurrent wait_for_subtasks callers can subscribe at once (one
    // per coordinator task). The default of 10 would print noisy warnings.
    super()
    this.setMaxListeners(0)
  }

  /** Current sequence counter — callers read this before reading DB state, to know where to subscribe from. */
  currentSeq(): number {
    return this.seqCounter
  }

  emitSubtaskEvent(event: Omit<SubtaskEvent, 'seq' | 'at'>): SubtaskEvent {
    const full: SubtaskEvent = { ...event, seq: ++this.seqCounter, at: Date.now() }
    this.buffer.push(full)
    if (this.buffer.length > RING_BUFFER_SIZE) this.buffer.shift()
    this.emit('event', full)
    return full
  }

  /** Events still in the buffer with seq > sinceSeq, oldest first. May be incomplete if more than RING_BUFFER_SIZE events landed since — callers should treat a gap as "re-read DB state", which `wait_for_subtasks` already does on every call. */
  eventsSince(sinceSeq: number): SubtaskEvent[] {
    return this.buffer.filter((e) => e.seq > sinceSeq)
  }

  /**
   * Resolves as soon as an event matching `predicate` arrives — checking
   * anything already buffered at/after `sinceSeq` first, so a caller that
   * read DB state, then called this, can never miss an event that landed in
   * between. Resolves with `null` on timeout, and the subscription is always
   * cleaned up (no leaked listeners).
   */
  waitFor(
    predicate: (event: SubtaskEvent) => boolean,
    opts: { sinceSeq: number; timeoutMs: number; signal?: AbortSignal }
  ): Promise<SubtaskEvent | null> {
    const buffered = this.eventsSince(opts.sinceSeq).find(predicate)
    if (buffered) return Promise.resolve(buffered)

    return new Promise((resolve) => {
      let settled = false
      const cleanup = () => {
        if (settled) return
        settled = true
        this.off('event', onEvent)
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const onEvent = (event: SubtaskEvent) => {
        if (!predicate(event)) return
        cleanup()
        resolve(event)
      }
      const onAbort = () => {
        cleanup()
        resolve(null)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(null)
      }, opts.timeoutMs)
      // Caller ends shutting the wait down early (parent session interrupted/stopped).
      opts.signal?.addEventListener('abort', onAbort)
      this.on('event', onEvent)
    })
  }
}

/** One bus per process — every emitter and every `wait_for_subtasks` caller shares it. */
export const subtaskEvents = new SubtaskEventBus()
