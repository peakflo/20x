import { afterAll, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'fs'
import { Script, createContext } from 'vm'

// The broker only touches Electron APIs inside its command methods; the pure
// helpers under test here need nothing from it. `fromId` is configurable so
// reload/navigation tests can hand the broker a fake WebContents.
const electronMocks = vi.hoisted(() => ({
  fromId: vi.fn((): unknown => null),
  agentSession: {},
  userData: `/tmp/20x-panel-browser-broker-test-${process.pid}-${Date.now()}`,
  getPath: vi.fn()
}))
electronMocks.getPath.mockReturnValue(electronMocks.userData)
afterAll(() => rmSync(electronMocks.userData, { recursive: true, force: true }))

vi.mock('electron', () => ({
  app: { getPath: electronMocks.getPath },
  session: { fromPartition: () => electronMocks.agentSession },
  webContents: { fromId: electronMocks.fromId }
}))

import {
  buildClickScript,
  buildGetScript,
  buildResourceTimingScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
  buildUploadTargetScript,
  buildWaitScript,
  consoleLevelName,
  evalErrorMessage,
  filterConsoleEntries,
  normalizeRef,
  PanelBrowserBroker,
  panelBrowserBroker,
  parseResourceTimingResult,
  parseSnapshotResult,
  pushConsoleEntry,
  resolvePanelForTask,
  sanitizeRecordingTarget,
  unwrapEval,
  CONSOLE_BUFFER_CAP,
  type ConsoleEntry,
  type PanelRegistry
} from './panel-browser-broker'

function registry(entries: Array<[string, { webContentsId: number; taskIds: string[] }]>): PanelRegistry {
  return new Map(entries.map(([id, v]) => [id, { webContentsId: v.webContentsId, taskIds: new Set(v.taskIds) }]))
}

describe('resolvePanelForTask', () => {
  const reg = registry([
    ['p1', { webContentsId: 11, taskIds: ['tA'] }],
    ['p2', { webContentsId: 12, taskIds: ['tA', 'tB'] }]
  ])

  it('auto-binds when exactly one panel is linked to the task', () => {
    expect(resolvePanelForTask(reg, 'tB')).toEqual({ ok: true, panelId: 'p2' })
  })

  it('rejects ambiguity instead of guessing', () => {
    const r = resolvePanelForTask(reg, 'tA')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('p1, p2')
  })

  it('errors with guidance when nothing is linked', () => {
    const r = resolvePanelForTask(registry([]), 'tX')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('No browser panel is linked')
  })

  it('accepts an explicit linked panel_id', () => {
    expect(resolvePanelForTask(reg, 'tA', 'p1')).toEqual({ ok: true, panelId: 'p1' })
  })

  it('rejects an unlinked or unknown panel_id', () => {
    const unlinked = resolvePanelForTask(reg, 'tB', 'p1')
    expect(unlinked.ok).toBe(false)
    const unknown = resolvePanelForTask(reg, 'tA', 'nope')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain('Unknown browser panel')
  })
})

describe('normalizeRef', () => {
  it('strips the @ prefix', () => {
    expect(normalizeRef('@e12')).toBe('e12')
    expect(normalizeRef('e3')).toBe('e3')
  })
})

describe('recording command targets', () => {
  it('keeps ordinary selectors and masks common secret-bearing selectors', () => {
    expect(sanitizeRecordingTarget('#save-button')).toBe('#save-button')
    expect(sanitizeRecordingTarget('  form   button.primary  ')).toBe('form button.primary')
    expect(sanitizeRecordingTarget('input[name="password"]')).toBe('[sensitive selector]')
    expect(sanitizeRecordingTarget(`[data-key="${'a'.repeat(40)}"]`)).toBe('[sensitive selector]')
  })
})

describe('snapshot script + parser round-trip', () => {
  it('script labels elements with data-bx-ref and caps output', () => {
    const script = buildSnapshotScript()
    expect(script).toContain('data-bx-ref')
    expect(script).toContain('120')
    expect(script).toContain("'[redacted]'")
    expect(script).toContain('sensitive(el)')
    expect(script.trim().startsWith('(() =>')).toBe(true)
  })

  it('parses a well-formed payload', () => {
    const payload = JSON.stringify({ url: 'https://x.io', title: 'X', elements: [{ ref: 'e1', role: 'button', name: 'Go' }] })
    expect(parseSnapshotResult(payload)).toMatchObject({ url: 'https://x.io', title: 'X' })
  })

  it('accepts an already-parsed object (executeJavaScript may return it unwrapped)', () => {
    expect(parseSnapshotResult({ url: 'https://x.io', title: 'X', elements: [] })).toMatchObject({ url: 'https://x.io' })
  })

  it('rejects malformed payloads', () => {
    expect(parseSnapshotResult(null)).toHaveProperty('error')
    expect(parseSnapshotResult('not json')).toHaveProperty('error')
    expect(parseSnapshotResult('{}')).toHaveProperty('error')
  })
})

describe('interaction scripts', () => {
  it('click resolves refs via data-bx-ref', () => {
    const script = buildClickScript('@e7')
    expect(script).toContain('[data-bx-ref=\\"e7\\"]')
  })

  it('click treats non-ref input as a CSS selector', () => {
    expect(buildClickScript('#submit')).toContain('"#submit"')
  })

  it('type embeds text safely and supports submit', () => {
    const script = buildTypeScript('@e2', 'he said "hi"', true)
    expect(script).toContain('"he said \\"hi\\""')
    expect(script).toContain('requestSubmit')
  })

  it('scroll defaults downward and honors direction', () => {
    expect(buildScrollScript()).toContain('window.scrollBy(0, 600)')
    expect(buildScrollScript('up')).toContain('window.scrollBy(0, -600)')
    expect(buildScrollScript(undefined, undefined, '@e1')).toContain('scrollIntoView')
  })

  it('get covers url/title/text only', () => {
    expect(buildGetScript('url')).toContain('location.href')
    expect(buildGetScript('title')).toContain('document.title')
    expect(buildGetScript('text')).toContain('innerText')
    expect(buildGetScript('cookies')).toContain('error')
  })

  it('wait bounds its timeout and escapes values', () => {
    expect(buildWaitScript('text', 'Done', 500)).toContain('"Done"')
    expect(buildWaitScript('selector', '.ok', 999999)).not.toContain('999999')
    expect(buildWaitScript('url', 'dashboard', 5000)).toContain('location.href.includes("dashboard")')
  })
})

describe('unwrapEval', () => {
  it('parses JSON strings into objects', () => {
    expect(unwrapEval('{"ok":true}')).toEqual({ ok: true })
  })
  it('wraps non-JSON strings as values', () => {
    expect(unwrapEval('plain')).toEqual({ ok: true, value: 'plain' })
  })
  it('passes objects through', () => {
    expect(unwrapEval({ ok: false })).toEqual({ ok: false })
  })
})

describe('registry lifecycle', () => {
  it('rejects a dead webContents instead of exposing it to agents', () => {
    panelBrowserBroker.registerPanel('px', 999_999, ['taskZ'])
    expect(panelBrowserBroker.listPanels('taskZ')).toEqual([])
    expect(panelBrowserBroker.listPanels('other')).toEqual([])
    expect(panelBrowserBroker.setPanelTasks('missing', [])).toBe(false)
    expect(panelBrowserBroker.unregisterPanel('px')).toBe(false)
    expect(panelBrowserBroker.unregisterPanel('px')).toBe(false)
    panelBrowserBroker.stopAll()
  })
  it('rejects a webview from the application session', () => {
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, session: {} })
    panelBrowserBroker.registerPanel('app', 88, ['taskZ'])
    expect(panelBrowserBroker.listPanels('taskZ')).toEqual([])
    electronMocks.fromId.mockReturnValue(null)
  })
})

describe('reload hard flag', () => {
  function fakeWebContents(url: string) {
    let settle: (() => void) | null = null
    const settleSoon = (): void => {
      queueMicrotask(() => settle?.())
    }
    const wc = {
      reload: vi.fn(settleSoon),
      reloadIgnoringCache: vi.fn(settleSoon),
      isDestroyed: vi.fn(() => false),
      once: vi.fn((_event: string, cb: () => void) => {
        settle = cb
      }),
      removeListener: vi.fn(),
      getURL: vi.fn(() => url)
    }
    return wc
  }

  it('bypasses the cache when hard is set', async () => {
    const wc = fakeWebContents('https://x.io/after-hard')
    electronMocks.fromId.mockReturnValue(Object.assign(wc, { session: electronMocks.agentSession }))
    panelBrowserBroker.registerPanel('p-hard', 42, ['task-hard'])
    try {
      const result = await panelBrowserBroker.reload('task-hard', 'p-hard', true)
      expect(wc.reloadIgnoringCache).toHaveBeenCalledTimes(1)
      expect(wc.reload).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: true, url: 'https://x.io/after-hard' })
    } finally {
      panelBrowserBroker.unregisterPanel('p-hard')
    }
  })

  it('defaults to a normal cached reload', async () => {
    const wc = fakeWebContents('https://x.io/after-soft')
    electronMocks.fromId.mockReturnValue(Object.assign(wc, { session: electronMocks.agentSession }))
    panelBrowserBroker.registerPanel('p-soft', 43, ['task-soft'])
    try {
      const result = await panelBrowserBroker.reload('task-soft', 'p-soft')
      expect(wc.reload).toHaveBeenCalledTimes(1)
      expect(wc.reloadIgnoringCache).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: true, url: 'https://x.io/after-soft' })
    } finally {
      panelBrowserBroker.unregisterPanel('p-soft')
    }
  })
})

describe('console helpers', () => {
  it('maps Electron console-message levels to names', () => {
    expect(consoleLevelName(0)).toBe('debug')
    expect(consoleLevelName(1)).toBe('info')
    expect(consoleLevelName(2)).toBe('warning')
    expect(consoleLevelName(3)).toBe('error')
    expect(consoleLevelName(99)).toBe('error')
  })

  it('caps the per-panel buffer at CONSOLE_BUFFER_CAP', () => {
    const buffer: ConsoleEntry[] = []
    for (let i = 0; i < CONSOLE_BUFFER_CAP + 10; i++) {
      pushConsoleEntry(buffer, { level: 'info', message: `m${i}`, source: '', line: 0, at: i })
    }
    expect(buffer).toHaveLength(CONSOLE_BUFFER_CAP)
    expect(buffer[0].message).toBe('m10')
    expect(buffer[buffer.length - 1].message).toBe(`m${CONSOLE_BUFFER_CAP + 9}`)
  })

  it('filters by level and honors the limit (newest last)', () => {
    const entries: ConsoleEntry[] = [
      { level: 'info', message: 'a', source: '', line: 0, at: 1 },
      { level: 'error', message: 'b', source: '', line: 0, at: 2 },
      { level: 'error', message: 'c', source: '', line: 0, at: 3 }
    ]
    expect(filterConsoleEntries(entries, { level: 'error' }).map((e) => e.message)).toEqual(['b', 'c'])
    expect(filterConsoleEntries(entries, { limit: 2 }).map((e) => e.message)).toEqual(['b', 'c'])
    expect(filterConsoleEntries(entries, {})).toHaveLength(3)
  })
})

describe('resource timing script', () => {
  it('reads the performance timeline and caps rows', () => {
    const script = buildResourceTimingScript('api', 25)
    expect(script).toContain("getEntriesByType('navigation')")
    expect(script).toContain("getEntriesByType('resource')")
    expect(script).toContain('slice(-25)')
    expect(script).toContain('"api"')
  })

  it('clamps the limit to the result cap', () => {
    expect(buildResourceTimingScript(undefined, 999999)).toContain('slice(-200)')
  })

  it('parses a well-formed payload and rejects malformed ones', () => {
    const payload = JSON.stringify({
      navigation: [{ url: 'https://x.io/', initiator: 'navigation', durationMs: 1, transferSize: 2, decodedSize: 3, status: 200 }],
      resources: []
    })
    expect(parseResourceTimingResult(payload)).toMatchObject({ resources: [] })
    expect(parseResourceTimingResult({ navigation: [], resources: [] })).toMatchObject({ navigation: [] })
    expect(parseResourceTimingResult(null)).toHaveProperty('error')
    expect(parseResourceTimingResult('not json')).toHaveProperty('error')
    expect(parseResourceTimingResult('{"navigation":[]}')).toHaveProperty('error')
  })
})

describe('broker console buffering', () => {
  type ConsoleListener = (event: unknown, level: number, message: string, line: number, sourceId: string) => void

  function fakeConsoleWebContents() {
    let consoleListener: ConsoleListener | null = null
    return {
      listener: () => consoleListener,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://x.io/'),
      on: vi.fn((event: string, cb: ConsoleListener) => {
        if (event === 'console-message') consoleListener = cb
      }),
      once: vi.fn(),
      removeListener: vi.fn(),
      executeJavaScript: vi.fn(async () => '{}')
    }
  }

  it('buffers console-message events per panel with level/line/source', async () => {
    const wc = fakeConsoleWebContents()
    electronMocks.fromId.mockReturnValue(Object.assign(wc, { session: electronMocks.agentSession }))
    panelBrowserBroker.registerPanel('p-console', 44, ['task-console'])
    try {
      expect(wc.on).toHaveBeenCalledWith('console-message', expect.any(Function))
      wc.listener()?.({}, 3, 'boom', 42, 'https://x.io/app.js')
      wc.listener()?.({}, 1, 'hello', 7, 'https://x.io/app.js')
      const all = (await panelBrowserBroker.console('task-console', {}, 'p-console')) as unknown as {
        entries: ConsoleEntry[]
        count: number
      }
      expect(all.count).toBe(2)
      expect(all.entries[0]).toMatchObject({ level: 'error', message: 'boom', line: 42 })
      const errors = (await panelBrowserBroker.console('task-console', { level: 'error' }, 'p-console')) as unknown as {
        entries: ConsoleEntry[]
      }
      expect(errors.entries.map((e) => e.message)).toEqual(['boom'])
    } finally {
      panelBrowserBroker.unregisterPanel('p-console')
    }
  })

  it('drains the buffer when clear is set and isolates panels', async () => {
    const wc = fakeConsoleWebContents()
    electronMocks.fromId.mockReturnValue(Object.assign(wc, { session: electronMocks.agentSession }))
    panelBrowserBroker.registerPanel('p-console-a', 45, ['task-console-a'])
    panelBrowserBroker.registerPanel('p-console-b', 46, ['task-console-b'])
    try {
      const drained = (await panelBrowserBroker.console('task-console-a', { clear: true }, 'p-console-a')) as unknown as {
        entries: ConsoleEntry[]
      }
      expect(Array.isArray(drained.entries)).toBe(true)
      // Other panels are untouched by the drain.
      const other = (await panelBrowserBroker.console('task-console-b', {}, 'p-console-b')) as unknown as {
        entries: ConsoleEntry[]
      }
      expect(Array.isArray(other.entries)).toBe(true)
    } finally {
      panelBrowserBroker.unregisterPanel('p-console-a')
      panelBrowserBroker.unregisterPanel('p-console-b')
    }
  })
})

describe('broker network', () => {
  it('returns parsed navigation + resource entries', async () => {
    const payload = JSON.stringify({
      navigation: [{ url: 'https://x.io/', initiator: 'navigation', durationMs: 10, transferSize: 5, decodedSize: 6, status: 200 }],
      resources: [{ url: 'https://x.io/api', initiator: 'fetch', durationMs: 3, transferSize: 1, decodedSize: 2, status: 200 }]
    })
    const wc = {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://x.io/'),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      executeJavaScript: vi.fn(async () => payload)
    }
    electronMocks.fromId.mockReturnValue(Object.assign(wc, { session: electronMocks.agentSession }))
    panelBrowserBroker.registerPanel('p-network', 47, ['task-network'])
    try {
      const result = (await panelBrowserBroker.network('task-network', 'api', 50, 'p-network')) as unknown as {
        navigation: unknown[]
        resources: Array<{ url: string }>
      }
      expect(result.navigation).toHaveLength(1)
      expect(result.resources.map((r) => r.url)).toEqual(['https://x.io/api'])
      expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
    } finally {
      panelBrowserBroker.unregisterPanel('p-network')
    }
  })
})

describe('broker recording stop', () => {
  it('queues the input flush and saves a final post-action snapshot before stopping', async () => {
    type ConsoleListener = (event: unknown, level: number, message: string, line: number, sourceId: string) => void
    let consoleListener: ConsoleListener | undefined
    let messagePrefix = ''
    let pageText = 'before handler'
    const snapshot = () => ({ url: 'https://x.io/form?secret=hidden', text: pageText, truncated: false, elements: [] })
    const wc = {
      id: 91,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://x.io/form?secret=hidden'),
      getTitle: vi.fn(() => 'Form'),
      on: vi.fn((event: string, cb: ConsoleListener) => {
        if (event === 'console-message') consoleListener = cb
      }),
      executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, scripts: Array<{ code: string }>) => {
        const code = scripts[0].code
        const match = code.match(/__20X_RECORDING__[a-f0-9-]+:/)
        if (match) messagePrefix = match[0]
        if (code.includes('__recordingCleanup?.') || code.includes("typeof globalThis.__recordingCleanup")) {
          consoleListener?.({ message: messagePrefix + JSON.stringify({ action: 'input', target: '#1 #name | input:Name', snapshot: snapshot() }) }, 1, '', 0, '')
          pageText = 'after handler'
          consoleListener?.({ message: messagePrefix + JSON.stringify({ action: 'recording-flush-complete' }) }, 1, '', 0, '')
          return true
        }
        if (code.includes('return snapshot()')) return snapshot()
        return true
      })
    }

    const broker = new PanelBrowserBroker()
    electronMocks.fromId.mockReturnValue(Object.assign(wc, { session: electronMocks.agentSession }))
    broker.registerPanel('p-record', wc.id, ['task-record'])
    const started = await broker.startRecording('p-record')
    expect(started).toHaveProperty('ok', true)
    const recordingId = 'recording' in started ? started.recording.id : ''

    const stopped = await broker.stopRecording('p-record')
    expect(stopped).toHaveProperty('ok', true)
    const rows = broker.recordings.steps('task-record', recordingId).steps
    expect(rows.map((row) => row.action)).toEqual(['recording-start', 'input', 'recording-stop'])
    expect(rows[1]).toMatchObject({ snapshotPhase: 'before-action', target: '#1 #name | input:Name' })
    expect(rows[2]).toMatchObject({ snapshotPhase: 'final' })
    const finalSnapshot = broker.recordings.snapshot('task-record', recordingId, rows[2].snapshotId!)
    expect(finalSnapshot.text).toBe('after handler')
    expect(finalSnapshot.url).toBe('https://x.io/form')
  })

  it('interrupts after one failed capture write and keeps the failure visible', async () => {
    const snapshot = { url: 'https://x.io/', text: 'page', truncated: false, elements: [] }
    const wc = {
      id: 92,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://x.io/'),
      getTitle: vi.fn(() => 'Page'),
      on: vi.fn(),
      executeJavaScript: vi.fn(async () => JSON.stringify({ ok: true })),
      executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, scripts: Array<{ code: string }>) =>
        scripts[0].code.includes('return snapshot()') ? snapshot : true
      )
    }
    const broker = new PanelBrowserBroker()
    electronMocks.fromId.mockReturnValue(Object.assign(wc, { session: electronMocks.agentSession }))
    broker.registerPanel('p-write-failure', wc.id, ['task-write-failure'])
    await broker.startRecording('p-write-failure')
    const append = vi.spyOn(broker.recordings, 'append').mockImplementation(() => { throw new Error('disk full') })

    try {
      expect(await broker.click('task-write-failure', '#save', 'p-write-failure')).toEqual({ ok: true })
      expect(append).toHaveBeenCalledTimes(1)
      expect(broker.recordingStatus('p-write-failure').recording).toMatchObject({
        status: 'interrupted',
        gaps: expect.arrayContaining(['Recording stopped because capture data could not be written.'])
      })
    } finally {
      append.mockRestore()
      broker.unregisterPanel('p-write-failure')
    }
  })
})

// ── Script escaping (issue: agent text spliced into page script) ────────────

const NASTY_VALUES = [
  'line one\nline two',
  "it's",
  'say "hi"',
  'back`tick`',
  '${globalThis.pwned = 1}',
  "'); globalThis.pwned = 1; ('",
  '"); globalThis.pwned = 1; ("',
  '</script><script>globalThis.pwned = 1</script>',
  '\\u2028     end',
  '\\'
]

/** Runs a builder's script in a sandbox with a minimal fake DOM. */
async function runScript(script: string, ctx: Record<string, unknown>): Promise<Record<string, unknown>> {
  new Script(script) // must at least compile
  const context = createContext({ JSON, Promise, setTimeout, ...ctx })
  const raw = await new Script(script).runInContext(context)
  expect(context.pwned).toBeUndefined()
  return JSON.parse(raw as string)
}

describe('script escaping', () => {
  it('wait(text) treats the value as data: matches literally and never executes it', async () => {
    for (const value of NASTY_VALUES) {
      const hit = await runScript(buildWaitScript('text', value, 500), { document: { body: { innerText: `xx${value}xx` } }, Date })
      expect(hit).toMatchObject({ ok: true })
    }
  })

  it('wait timeout message echoes the value verbatim without breaking the script', async () => {
    for (const value of NASTY_VALUES) {
      let now = 0
      const fakeDate = { now: () => (now += 1000) }
      const miss = await runScript(buildWaitScript('text', value, 500), { document: { body: { innerText: '' } }, Date: fakeDate })
      expect(miss.error).toBe(`Timed out after 500ms waiting for text: ${value}`)
    }
  })

  it('wait(selector|url) compiles for any value', async () => {
    for (const value of NASTY_VALUES) {
      const sel = await runScript(buildWaitScript('selector', value, 500), { document: { querySelector: (q: string) => (q === value ? {} : null) }, Date })
      expect(sel).toMatchObject({ ok: true })
      const url = await runScript(buildWaitScript('url', value, 500), { location: { href: `https://x.io/${value}` }, Date })
      expect(url).toMatchObject({ ok: true })
    }
  })

  it('click reports an unknown target without executing it', async () => {
    for (const value of NASTY_VALUES) {
      const result = await runScript(buildClickScript(value), { document: { querySelector: () => null } })
      expect(result.error).toContain(JSON.stringify(value))
    }
  })

  it('type embeds text and selectors as data for inputs', async () => {
    for (const value of NASTY_VALUES) {
      const el = { tagName: 'INPUT', readOnly: false, value: '', focus: () => {}, dispatchEvent: () => true, closest: () => null }
      const proto = { set value(v: string) { el.value = v } }
      const result = await runScript(buildTypeScript(value, value), {
        document: { querySelector: (q: string) => (q === value ? el : null) },
        HTMLInputElement: { prototype: proto },
        HTMLTextAreaElement: { prototype: proto },
        Event: class { constructor(public type: string) {} }
      })
      expect(result).toEqual({ ok: true })
      expect(el.value).toBe(value)
    }
  })

  it('type reports a non-editable target without executing its name', async () => {
    for (const value of NASTY_VALUES) {
      const el = { tagName: 'A', isContentEditable: false, getAttribute: () => null, querySelector: () => null }
      const result = await runScript(buildTypeScript(value, 'x'), { document: { querySelector: () => el } })
      expect(result.error).toContain('is not an editable element')
    }
  })

  it('upload target script compiles for any target', async () => {
    for (const value of NASTY_VALUES) {
      const result = await runScript(buildUploadTargetScript(value, 'm1'), { document: { querySelector: () => null } })
      expect(result.error).toContain(JSON.stringify(value))
    }
  })
})

describe('invalid CSS selectors', () => {
  // Mimics the DOMException a real page throws for an unparsable selector.
  const syntaxError = (): never => { throw Object.assign(new Error("'a[[' is not a valid selector."), { name: 'SyntaxError' }) }
  const page = {
    createDocumentFragment: () => ({ querySelector: syntaxError }),
    querySelector: syntaxError,
    querySelectorAll: syntaxError
  }

  it('wait/click/type/scroll/upload return "Invalid selector: …" instead of throwing', async () => {
    const scripts = [
      buildWaitScript('selector', 'a[[', 500),
      buildClickScript('a[['),
      buildTypeScript('a[[', 'x'),
      buildScrollScript(undefined, undefined, 'a[['),
      buildUploadTargetScript('a[[', 'm1')
    ]
    for (const script of scripts) {
      expect(await runScript(script, { document: page, Date })).toEqual({ error: 'Invalid selector: a[[' })
    }
  })

  it('does not guard snapshot refs and lets valid selectors through', async () => {
    expect(buildClickScript('@e3')).not.toContain('createDocumentFragment')
    const ok = { createDocumentFragment: () => ({ querySelector: () => null }), querySelector: () => ({}) }
    expect(await runScript(buildWaitScript('selector', '.ok', 500), { document: ok, Date })).toMatchObject({ ok: true })
  })

  it('evalErrorMessage never yields an empty error', () => {
    expect(evalErrorMessage(new Error('boom'))).toBe('boom')
    expect(evalErrorMessage('bad')).toBe('bad')
    // executeJavaScript rejects with a plain {} when the page throws a DOMException.
    expect(evalErrorMessage({})).toMatch(/page script failed/)
    expect(evalErrorMessage(undefined)).toMatch(/page script failed/)
  })

  it('broker.wait surfaces a message when executeJavaScript rejects with a non-Error', async () => {
    const wc = fakeInputWebContents(212, { ok: true })
    wc.executeJavaScript.mockImplementation(async () => { throw {} })
    await withPanel(wc, async (broker) => {
      const result = await broker.wait('task-212', 'selector', 'div', 1000, 'p-212')
      expect(typeof result.error).toBe('string')
      expect(String(result.error).length).toBeGreaterThan(0)
    })
  })
})

describe('type into contenteditable', () => {
  it('only focuses + selects, then signals trusted input (no textContent writes)', () => {
    const script = buildTypeScript('@e1', 'hello')
    expect(script).not.toContain('textContent =')
    expect(script).toContain('trusted: true')
    expect(script).toContain('selectNodeContents')
  })
})

// ── Broker trusted input via mocked webContents ────────────────────────────

type EvalResponder = unknown | ((script: string) => unknown)

function fakeInputWebContents(id: number, evalResult: EvalResponder, opts: { attachThrows?: boolean; type?: string } = {}) {
  const sendCommand = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 7 }
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('png-bytes').toString('base64') }
    return {}
  })
  const log: string[] = []
  const wc = {
    id,
    log,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => 'https://editor.test/'),
    getType: vi.fn(() => opts.type ?? 'webview'),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    executeJavaScript: vi.fn(async (script: string) => {
      const value = typeof evalResult === 'function' ? (evalResult as (s: string) => unknown)(script) : evalResult
      return typeof value === 'string' ? value : JSON.stringify(value)
    }),
    insertText: vi.fn(async (text: string) => { log.push(`insertText:${text}`) }),
    sendInputEvent: vi.fn((ev: Electron.KeyboardInputEvent) => { log.push(`${ev.type}:${ev.keyCode}`) }),
    capturePage: vi.fn(async () => { throw new Error('UnknownVizError') }),
    debugger: {
      isAttached: vi.fn(() => false),
      attach: vi.fn(() => { if (opts.attachThrows) throw new Error('Another debugger is already attached') }),
      detach: vi.fn(),
      sendCommand,
      on: vi.fn(),
      removeListener: vi.fn()
    }
  }
  return wc
}

/** Simulates a page with a contenteditable editor prepared by buildTypeScript. */
function editorPage(opts: { focused?: boolean; receives?: boolean; before?: string; after?: string } = {}) {
  let reads = 0
  return (script: string): unknown => {
    if (script.includes('removeAttribute(\'data-bx-type\')')) return { ok: true }
    if (script.includes('[data-bx-type=')) {
      // Each read after arming shows one more trusted input event (progress).
      const inputs = opts.receives === false ? 0 : reads++
      return { found: true, focused: opts.focused ?? true, text: inputs ? (opts.after ?? 'Title\nBody') : (opts.before ?? ''), inputs }
    }
    return { trusted: true, hadContent: (opts.before ?? '') !== '' }
  }
}

function withPanel<T>(wc: ReturnType<typeof fakeInputWebContents>, fn: (broker: PanelBrowserBroker) => Promise<T>): Promise<T> {
  const broker = new PanelBrowserBroker()
  electronMocks.fromId.mockReturnValue(Object.assign(wc, { session: electronMocks.agentSession }))
  broker.registerPanel(`p-${wc.id}`, wc.id, [`task-${wc.id}`])
  return fn(broker).finally(() => {
    broker.unregisterPanel(`p-${wc.id}`)
    electronMocks.fromId.mockReturnValue(null)
  })
}

const cdpCalls = (wc: ReturnType<typeof fakeInputWebContents>) => wc.debugger.sendCommand.mock.calls.map((c) => c as unknown as [string, Record<string, unknown>])

describe('broker trusted input', () => {
  it('disables background throttling for registered agent panels', async () => {
    const wc = fakeInputWebContents(201, { ok: true })
    await withPanel(wc, async () => {
      expect(wc.setBackgroundThrottling).toHaveBeenCalledWith(false)
    })
  })

  it('types into a rich editor through the guest webContents only (never CDP Input)', async () => {
    const wc = fakeInputWebContents(202, editorPage({ before: 'old' }))
    await withPanel(wc, async (broker) => {
      const result = await broker.type('task-202', '@e1', 'Title\nBody', false, 'p-202')
      expect(result).toEqual({ ok: true, input: 'trusted' })
      expect(wc.log).toEqual([
        'rawKeyDown:Backspace', 'keyUp:Backspace', // clears the selected old content
        'insertText:Title',
        'rawKeyDown:Enter', 'char:Enter', 'keyUp:Enter', // Enter → new block
        'insertText:Body'
      ])
      expect(wc.debugger.attach).not.toHaveBeenCalled()
      expect(cdpCalls(wc)).toEqual([])
      // The marker + input watcher are removed afterwards.
      const scripts = wc.executeJavaScript.mock.calls.map((c) => String(c[0]))
      expect(scripts[scripts.length - 1]).toContain("removeAttribute('data-bx-type')")
    })
  })

  it('appends without clearing when clear=false and presses Enter on submit', async () => {
    const wc = fakeInputWebContents(203, editorPage({ before: 'x', after: 'xmore' }))
    await withPanel(wc, async (broker) => {
      expect(await broker.type('task-203', '@e1', 'more', true, 'p-203', false)).toEqual({ ok: true, input: 'trusted' })
      expect(wc.log).toEqual(['insertText:more', 'rawKeyDown:Enter', 'char:Enter', 'keyUp:Enter'])
    })
  })

  it('sends nothing when the editor is not focused inside the page', async () => {
    const wc = fakeInputWebContents(209, editorPage({ focused: false }))
    await withPanel(wc, async (broker) => {
      const result = await broker.type('task-209', '@e1', 'secret\n', true, 'p-209')
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/keyboard focus/) })
      expect(wc.log).toEqual([])
    })
  })

  it('returns ok:false and does not submit when the page received nothing', async () => {
    const wc = fakeInputWebContents(210, editorPage({ receives: false }))
    await withPanel(wc, async (broker) => {
      const result = await broker.type('task-210', '@e1', 'hello', true, 'p-210')
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/did not receive/) })
      expect(wc.log).toEqual(['insertText:hello'])
    })
  })

  it('refuses keyboard input for a non-webview target', async () => {
    const wc = fakeInputWebContents(211, editorPage(), { type: 'window' })
    await withPanel(wc, async (broker) => {
      expect(await broker.type('task-211', '@e1', 'x', false, 'p-211')).toMatchObject({ ok: false })
      expect(await broker.pressKey('task-211', 'Enter', 'p-211')).toMatchObject({ ok: false })
      expect(wc.log).toEqual([])
    })
  })

  it('keeps the value-setter path for plain inputs (no keyboard events)', async () => {
    const wc = fakeInputWebContents(204, { ok: true })
    await withPanel(wc, async (broker) => {
      expect(await broker.type('task-204', '#q', 'hello', false, 'p-204')).toEqual({ ok: true })
      expect(wc.debugger.attach).not.toHaveBeenCalled()
      expect(wc.log).toEqual([])
    })
  })

  it('press_key sends key events to the guest with modifiers', async () => {
    const wc = fakeInputWebContents(206, { ok: true })
    await withPanel(wc, async (broker) => {
      expect(await broker.pressKey('task-206', 'Control+B', 'p-206')).toEqual({ ok: true, input: 'trusted' })
      expect(wc.sendInputEvent.mock.calls.map((c) => c[0])).toEqual([
        { type: 'rawKeyDown', keyCode: 'B', modifiers: ['control'] },
        { type: 'keyUp', keyCode: 'B', modifiers: ['control'] }
      ])
      expect(wc.debugger.attach).not.toHaveBeenCalled()
      expect(wc.executeJavaScript).not.toHaveBeenCalled()
      expect(await broker.pressKey('task-206', 'Hyper+Q', 'p-206')).toHaveProperty('error')
    })
  })

  it('uploads validated files through DOM.setFileInputFiles', async () => {
    const wc = fakeInputWebContents(207, { ok: true, multiple: false, disabled: false })
    await withPanel(wc, async (broker) => {
      expect(await broker.uploadFile('task-207', 'input[type=file]', ['/ws/a.png'], 'p-207')).toEqual({ ok: true, files: 1 })
      expect(cdpCalls(wc)).toContainEqual(['DOM.setFileInputFiles', { files: ['/ws/a.png'], nodeId: 7 }])
      expect(await broker.uploadFile('task-207', 'input[type=file]', ['/ws/a.png', '/ws/b.png'], 'p-207')).toHaveProperty('error')
    })
  })

  it('falls back to CDP Page.captureScreenshot when capturePage fails', async () => {
    const wc = fakeInputWebContents(208, { ok: true })
    await withPanel(wc, async (broker) => {
      const result = await broker.screenshot('task-208', 'p-208')
      expect(result).toMatchObject({ ok: true })
      expect(cdpCalls(wc).map(([m]) => m)).toContain('Page.captureScreenshot')
      rmSync(result.path as string, { force: true })
    })
  })
})
