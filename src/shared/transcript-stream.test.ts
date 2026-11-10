import { describe, expect, it, vi } from 'vitest'
import {
  TranscriptDeltaEncoder,
  TranscriptStreamReceiver,
  applyTranscriptOps,
  type TranscriptDeltaEvent,
  type TranscriptPartLike,
  type TranscriptReceiverHost,
  type TranscriptSyncResult
} from './transcript-stream'
import { FakeTranscriptServer } from './transcript-stream.testing'

function part(partId: string, over: Partial<TranscriptPartLike> = {}): TranscriptPartLike {
  return {
    taskId: 't1', partId, seq: 1, role: 'assistant', content: '', partType: 'text',
    createdAt: 100, updatedAt: 100, rev: 1, ...over
  }
}

describe('TranscriptDeltaEncoder (sender diffing)', () => {
  it('sends a new part whole, then only the appended text', () => {
    const enc = new TranscriptDeltaEncoder({ epoch: 'e' })
    const first = enc.encode('t1', [part('a', { content: 'Hello', rev: 1 })], 1)
    expect(first).toMatchObject({ taskId: 't1', epoch: 'e', seq: 1, maxRev: 1 })
    expect(first.ops).toEqual([{ op: 'put', part: part('a', { content: 'Hello', rev: 1 }) }])

    const second = enc.encode('t1', [part('a', { content: 'Hello world', rev: 2, updatedAt: 200 })], 2)
    expect(second.seq).toBe(2)
    expect(second.ops).toEqual([{ op: 'append', partId: 'a', at: 5, text: ' world', rev: 2, updatedAt: 200 }])
  })

  it('numbers events per task', () => {
    const enc = new TranscriptDeltaEncoder()
    enc.encode('t1', [part('a')], 1)
    enc.encode('t1', [part('a')], 2)
    expect(enc.encode('t2', [part('b', { taskId: 't2' })], 3).seq).toBe(1)
    expect(enc.currentSeq('t1')).toBe(2)
    expect(enc.currentSeq('unknown')).toBe(0)
  })

  it('falls back to a whole part when an earlier part is rewritten or truncated', () => {
    const enc = new TranscriptDeltaEncoder()
    enc.encode('t1', [part('a', { content: 'first draft' }), part('b', { content: 'later', createdAt: 200 })], 2)
    const rewrite = enc.encode('t1', [part('a', { content: 'second draft', rev: 3 })], 3)
    expect(rewrite.ops).toEqual([{ op: 'put', part: part('a', { content: 'second draft', rev: 3 }) }])
    const truncate = enc.encode('t1', [part('a', { content: 'second', rev: 4 })], 4)
    expect(truncate.ops[0].op).toBe('put')
  })

  it('falls back to a whole part when anything besides content changed (tool status)', () => {
    const enc = new TranscriptDeltaEncoder()
    const running = { name: 'Bash', status: 'running' }
    enc.encode('t1', [part('tool', { partType: 'tool', tool: running })], 1)
    const done = enc.encode('t1', [part('tool', { partType: 'tool', tool: { ...running, status: 'completed' }, rev: 2 })], 2)
    expect(done.ops[0].op).toBe('put')
  })

  it('sends a part whole again once its baseline was evicted (bounded memory)', () => {
    const enc = new TranscriptDeltaEncoder({ maxPartsPerTask: 2, maxTasks: 1 })
    enc.encode('t1', [part('a', { content: 'x' }), part('b', { content: 'y' }), part('c', { content: 'z' })], 3)
    expect(enc.encode('t1', [part('a', { content: 'xx' })], 4).ops[0].op).toBe('put')
    expect(enc.encode('t1', [part('c', { content: 'zz' })], 5).ops[0].op).toBe('append')
    enc.encode('t2', [part('q', { taskId: 't2' })], 6)
    // t1 fell out of the task LRU.
    expect(enc.encode('t1', [part('c', { content: 'zzz' })], 7).ops[0].op).toBe('put')
  })

  it('keeps the bytes of a streamed answer linear in its length', () => {
    const enc = new TranscriptDeltaEncoder()
    let content = ''
    let bytes = 0
    for (let i = 0; i < 200; i++) {
      content += 'x'.repeat(100)
      bytes += JSON.stringify(enc.encode('t1', [part('a', { content, rev: i + 1 })], i + 1)).length
    }
    // 20 KB of text: well under 2x its own size on the wire (was ~1 MB).
    expect(bytes).toBeLessThan(2 * 20_000 + 200 * 150)
  })
})

describe('applyTranscriptOps', () => {
  it('appends onto the current content when `at` matches', () => {
    const current = part('a', { content: 'Hel' })
    const out = applyTranscriptOps([{ op: 'append', partId: 'a', at: 3, text: 'lo', rev: 2, updatedAt: 5 }], () => current)
    expect(out).toEqual([{ ...current, content: 'Hello', rev: 2, updatedAt: 5 }])
  })

  it('chains several appends to the same part inside one event', () => {
    const out = applyTranscriptOps([
      { op: 'put', part: part('a', { content: 'a' }) },
      { op: 'append', partId: 'a', at: 1, text: 'b', rev: 2, updatedAt: 2 },
      { op: 'append', partId: 'a', at: 2, text: 'c', rev: 3, updatedAt: 3 }
    ], () => undefined)
    expect(out?.map((p) => p.content)).toEqual(['abc'])
  })

  it('refuses an append that does not fit (diverged or missing part)', () => {
    expect(applyTranscriptOps([{ op: 'append', partId: 'a', at: 2, text: 'x', rev: 2, updatedAt: 2 }], () => part('a', { content: 'abc' }))).toBeNull()
    expect(applyTranscriptOps([{ op: 'append', partId: 'a', at: 0, text: 'x', rev: 2, updatedAt: 2 }], () => undefined)).toBeNull()
  })
})

// ── Receiver ────────────────────────────────────────────────────────────────

function harness(server: FakeTranscriptServer, options: { tracked?: boolean } = {}) {
  const store = new Map<string, Map<string, TranscriptPartLike>>()
  const revs = new Map<string, number>()
  const fetches: Array<{ taskId: string; sinceRev: number | undefined }> = []
  let gate: Promise<void> | null = null
  const host: TranscriptReceiverHost<TranscriptPartLike> = {
    isTracked: (taskId) => options.tracked !== false && store.has(taskId),
    getPart: (taskId, partId) => store.get(taskId)?.get(partId),
    getRev: (taskId) => revs.get(taskId) ?? 0,
    commit: (taskId, parts, maxRev) => {
      const map = store.get(taskId)!
      for (const p of parts) map.set(p.partId, p)
      revs.set(taskId, Math.max(revs.get(taskId) ?? 0, maxRev))
    },
    replace: (taskId, parts, maxRev) => {
      store.set(taskId, new Map(parts.map((p) => [p.partId, p])))
      revs.set(taskId, maxRev)
      return true
    },
    fetchSync: async (taskId, sinceRev): Promise<TranscriptSyncResult> => {
      fetches.push({ taskId, sinceRev })
      if (gate) await gate
      return server.sync(taskId, sinceRev)
    }
  }
  const receiver = new TranscriptStreamReceiver(host)
  const content = (taskId: string, partId: string): string | undefined => store.get(taskId)?.get(partId)?.content
  const hold = (): (() => void) => {
    let release!: () => void
    gate = new Promise<void>((resolve) => { release = () => { gate = null; resolve() } })
    return release
  }
  return { receiver, store, fetches, content, hold, host }
}

describe('TranscriptStreamReceiver (receiver applying)', () => {
  it('applies contiguous events after a full sync', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: 'He' }])
    const h = harness(server)
    await h.receiver.resync('t1', { full: true })
    expect(h.receiver.position('t1')).toEqual({ epoch: 'epoch-1', seq: 1 })

    const e2 = server.write('t1', [{ partId: 'a', content: 'Hello' }])
    expect(e2.ops[0].op).toBe('append')
    expect(h.receiver.handle(e2)).toBe('applied')
    expect(h.content('t1', 'a')).toBe('Hello')
  })

  it('drops stale and duplicate events (seq <= lastSeq)', async () => {
    const server = new FakeTranscriptServer()
    const e1 = server.write('t1', [{ partId: 'a', content: 'one' }])
    const h = harness(server)
    await h.receiver.resync('t1', { full: true })
    expect(h.receiver.handle(e1)).toBe('stale')
    const e2 = server.write('t1', [{ partId: 'a', content: 'one two' }])
    expect(h.receiver.handle(e2)).toBe('applied')
    expect(h.receiver.handle(e2)).toBe('stale')
    expect(h.content('t1', 'a')).toBe('one two')
  })

  it('gap -> catch-up resync since rev, then replays buffered events in order', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: 'A' }])
    const h = harness(server)
    await h.receiver.resync('t1', { full: true })
    h.fetches.length = 0

    server.write('t1', [{ partId: 'a', content: 'AB' }]) // seq 2 — lost
    const e3 = server.write('t1', [{ partId: 'a', content: 'ABC' }])
    const release = h.hold()
    expect(h.receiver.handle(e3)).toBe('resyncing')
    expect(h.fetches).toEqual([{ taskId: 't1', sinceRev: 1 }])
    // Arrives while the resync is in flight: buffered, not applied on stale content.
    const e4 = server.write('t1', [{ partId: 'a', content: 'ABCD' }])
    expect(h.receiver.handle(e4)).toBe('resyncing')
    release()
    await h.receiver.resync('t1', { full: false }) // joins the in-flight request
    // The sync answered at seq 4 (server-side), so e3/e4 were stale and the
    // content is the latest.
    expect(h.content('t1', 'a')).toBe('ABCD')
    expect(h.receiver.position('t1')?.seq).toBe(4)
    expect(h.fetches).toHaveLength(1)

    const e5 = server.write('t1', [{ partId: 'a', content: 'ABCDE' }])
    expect(h.receiver.handle(e5)).toBe('applied')
    expect(h.content('t1', 'a')).toBe('ABCDE')
  })

  it('applies buffered events newer than the resync answer', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: 'x' }])
    const answer = server.sync('t1') // consistent with seq 1
    const e2 = server.write('t1', [{ partId: 'a', content: 'xy' }])
    const e3 = server.write('t1', [{ partId: 'a', content: 'xyz' }])
    const h = harness(server)
    h.store.set('t1', new Map())
    vi.spyOn(h.host, 'fetchSync').mockResolvedValueOnce(answer)
    // Both events arrived (out of order) while the answer was in flight.
    await h.receiver.resync('t1', { full: true, buffered: [e3, e2] })
    expect(h.content('t1', 'a')).toBe('xyz')
    expect(h.receiver.position('t1')?.seq).toBe(3)
  })

  it('out-of-order delivery (n+2 before n+1) converges to the latest content', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: '1' }])
    const h = harness(server)
    await h.receiver.resync('t1', { full: true })
    const e2 = server.write('t1', [{ partId: 'a', content: '12' }])
    const e3 = server.write('t1', [{ partId: 'a', content: '123' }])
    const pending = h.receiver.handle(e3)
    expect(pending).toBe('resyncing')
    h.receiver.handle(e2)
    await h.receiver.resync('t1', { full: false })
    expect(h.content('t1', 'a')).toBe('123')
  })

  it('unknown task or never-synced stream -> full resync on first event', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: 'history' }])
    const h = harness(server)
    h.store.set('t1', new Map()) // tracked but never synced
    const e = server.write('t1', [{ partId: 'a', content: 'history+' }])
    expect(h.receiver.handle(e)).toBe('resyncing')
    await h.receiver.resync('t1', { full: true })
    expect(h.fetches[0]).toEqual({ taskId: 't1', sinceRev: undefined })
    expect(h.content('t1', 'a')).toBe('history+')
  })

  it('ignores events for tasks the store does not follow (no fetch)', () => {
    const server = new FakeTranscriptServer()
    const h = harness(server)
    expect(h.receiver.handle(server.write('t9', [{ partId: 'a', content: 'x' }]))).toBe('ignored')
    expect(h.fetches).toHaveLength(0)
  })

  it('new epoch (main process restarted) -> full resync', async () => {
    const server = new FakeTranscriptServer('epoch-1')
    server.write('t1', [{ partId: 'a', content: 'before' }])
    const h = harness(server)
    await h.receiver.resync('t1', { full: true })
    h.fetches.length = 0
    server.restart('epoch-2')
    const e = server.write('t1', [{ partId: 'a', content: 'before after' }])
    expect(e.seq).toBe(1)
    expect(h.receiver.handle(e)).toBe('resyncing')
    await h.receiver.resync('t1', { full: true })
    expect(h.fetches).toEqual([{ taskId: 't1', sinceRev: undefined }])
    expect(h.receiver.position('t1')).toEqual({ epoch: 'epoch-2', seq: 1 })
    expect(h.content('t1', 'a')).toBe('before after')
  })

  it('reconnect (forgetAll) -> the next event triggers a full resync', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: 'x' }])
    const h = harness(server)
    await h.receiver.resync('t1', { full: true })
    h.receiver.forgetAll()
    h.fetches.length = 0
    server.write('t1', [{ partId: 'a', content: 'xy' }]) // sent while disconnected
    const e = server.write('t1', [{ partId: 'a', content: 'xyz' }])
    h.receiver.handle(e)
    await h.receiver.resync('t1', { full: true })
    expect(h.fetches).toEqual([{ taskId: 't1', sinceRev: undefined }])
    expect(h.content('t1', 'a')).toBe('xyz')
  })

  it('patch of an earlier part arrives whole and replaces it in place', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: 'draft' }, { partId: 'b', content: 'tail' }])
    const h = harness(server)
    await h.receiver.resync('t1', { full: true })
    const e = server.write('t1', [{ partId: 'a', content: 'rewritten' }])
    expect(e.ops[0].op).toBe('put')
    expect(h.receiver.handle(e)).toBe('applied')
    expect(h.content('t1', 'a')).toBe('rewritten')
    expect(h.content('t1', 'b')).toBe('tail')
  })

  it('an append that does not fit local content -> full resync', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: 'abc' }])
    const h = harness(server)
    await h.receiver.resync('t1', { full: true })
    h.store.get('t1')!.set('a', { ...h.store.get('t1')!.get('a')!, content: 'corrupted!' })
    h.fetches.length = 0
    const e = server.write('t1', [{ partId: 'a', content: 'abcd' }])
    expect(h.receiver.handle(e)).toBe('resyncing')
    await h.receiver.resync('t1', { full: true })
    expect(h.fetches).toEqual([{ taskId: 't1', sinceRev: undefined }])
    expect(h.content('t1', 'a')).toBe('abcd')
  })

  it('a failed resync forgets the position so the next event retries', async () => {
    const server = new FakeTranscriptServer()
    server.write('t1', [{ partId: 'a', content: 'x' }])
    const h = harness(server)
    h.store.set('t1', new Map())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(h.host, 'fetchSync').mockRejectedValueOnce(new Error('offline'))
    await h.receiver.resync('t1', { full: true })
    expect(h.receiver.position('t1')).toBeUndefined()
    const e = server.write('t1', [{ partId: 'a', content: 'xy' }])
    expect(h.receiver.handle(e)).toBe('resyncing')
    await h.receiver.resync('t1', { full: true })
    expect(h.content('t1', 'a')).toBe('xy')
  })

  it('stays correct over a long random stream with drops, duplicates and reordering', async () => {
    const server = new FakeTranscriptServer()
    const h = harness(server)
    h.store.set('t1', new Map())
    await h.receiver.resync('t1', { full: true })
    let seed = 7
    const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const texts = new Map<string, string>()
    const queue: TranscriptDeltaEvent[] = []
    for (let i = 0; i < 300; i++) {
      const id = rand() < 0.7 ? 'answer' : `p${Math.floor(rand() * 5)}`
      const prev = texts.get(id) ?? ''
      const next = rand() < 0.1 ? `rewrite ${i}` : prev + `w${i} `
      texts.set(id, next)
      queue.push(server.write('t1', [{ partId: id, content: next }]))
      while (queue.length > 0 && rand() < 0.6) {
        const idx = rand() < 0.2 && queue.length > 1 ? 1 : 0
        const [event] = queue.splice(idx, 1)
        if (rand() < 0.1) continue // dropped
        h.receiver.handle(event)
        if (rand() < 0.05) h.receiver.handle(event) // duplicate
      }
      if (rand() < 0.1) await Promise.resolve()
    }
    for (const event of queue) h.receiver.handle(event)
    while (h.receiver.isResyncing('t1')) await h.receiver.resync('t1', { full: false })
    // Safety-net catch-up (what the stores do at idle) covers a dropped tail.
    await h.receiver.resync('t1', { full: false })
    for (const [id, text] of texts) expect(h.content('t1', id)).toBe(text)
  })
})
