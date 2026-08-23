import { describe, expect, it, vi } from 'vitest'

// The broker only touches Electron APIs inside its command methods; the pure
// helpers under test here need nothing from it.
vi.mock('electron', () => ({
  app: {},
  webContents: { fromId: () => null }
}))

import {
  buildClickScript,
  buildGetScript,
  buildPressScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
  buildWaitScript,
  normalizeRef,
  panelBrowserBroker,
  parseSnapshotResult,
  resolveKeyName,
  resolvePanelForTask,
  unwrapEval,
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

describe('snapshot script + parser round-trip', () => {
  it('script labels elements with data-bx-ref and caps output', () => {
    const script = buildSnapshotScript()
    expect(script).toContain('data-bx-ref')
    expect(script).toContain('120')
    expect(script.trim().startsWith('(() =>')).toBe(true)
  })

  it('parses a well-formed payload', () => {
    const payload = JSON.stringify({ url: 'https://x.io', title: 'X', elements: [{ ref: 'e1', role: 'button', name: 'Go' }] })
    expect(parseSnapshotResult(payload)).toMatchObject({ url: 'https://x.io', title: 'X' })
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
