import { afterAll, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'fs'

// The broker only touches Electron APIs inside its command methods; the pure
// helpers under test here need nothing from it. `fromId` is configurable so
// reload/navigation tests can hand the broker a fake WebContents.
const electronMocks = vi.hoisted(() => ({
  fromId: vi.fn((): unknown => null),
  userData: `/tmp/20x-panel-browser-broker-test-${process.pid}-${Date.now()}`,
  getPath: vi.fn()
}))
electronMocks.getPath.mockReturnValue(electronMocks.userData)
afterAll(() => rmSync(electronMocks.userData, { recursive: true, force: true }))

vi.mock('electron', () => ({
  app: { getPath: electronMocks.getPath },
  webContents: { fromId: electronMocks.fromId }
}))

import {
  buildClickScript,
  buildGetScript,
  buildPressScript,
  buildResourceTimingScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
  buildWaitScript,
  consoleLevelName,
  filterConsoleEntries,
  normalizeRef,
  PanelBrowserBroker,
  panelBrowserBroker,
  parseResourceTimingResult,
  parseSnapshotResult,
  pushConsoleEntry,
  resolveKeyName,
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

  it('press maps known keys and rejects unknown ones', () => {
    expect(buildPressScript('Enter')).toContain('"keyCode":13')
    expect(buildPressScript('arrowdown')).toContain('"keyCode":40')
    expect(resolveKeyName('q')).toMatchObject({ key: 'Q' })
    expect(buildPressScript('meta+shift+p')).toContain('Unsupported key')
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
  it('register/unregister/list track linkage without touching live webContents', () => {
    // listPanels tolerates dead webContents ids (returns empty url/title).
    panelBrowserBroker.registerPanel('px', 999_999, ['taskZ'])
    expect(panelBrowserBroker.listPanels('taskZ')).toEqual([{ panelId: 'px', url: '', title: '' }])
    expect(panelBrowserBroker.listPanels('other')).toEqual([])
    expect(panelBrowserBroker.setPanelTasks('missing', [])).toBe(false)
    expect(panelBrowserBroker.unregisterPanel('px')).toBe(true)
    expect(panelBrowserBroker.unregisterPanel('px')).toBe(false)
    panelBrowserBroker.stopAll()
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
    electronMocks.fromId.mockReturnValue(wc)
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
    electronMocks.fromId.mockReturnValue(wc)
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
    electronMocks.fromId.mockReturnValue(wc)
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
    electronMocks.fromId.mockReturnValue(wc)
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
    electronMocks.fromId.mockReturnValue(wc)
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
    electronMocks.fromId.mockReturnValue(wc)
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
    electronMocks.fromId.mockReturnValue(wc)
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
