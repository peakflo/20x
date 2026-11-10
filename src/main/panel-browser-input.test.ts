import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'path'
import { Script, createContext } from 'vm'
import {
  buildEditorStateScript,
  buildFallbackKeyEvents,
  guestInputGuard,
  MAX_UPLOAD_FILES,
  MODIFIER_BITS,
  PanelDebuggerSessions,
  parseKeyCombo,
  pressKeyInGuest,
  resolveUploadPaths,
  splitTypingSegments,
  typeIntoEditor,
  type GuestInputWebContents,
  type InputWebContents,
  type ParsedKey,
  type UploadFs
} from './panel-browser-input'

function parsed(combo: string, platform: NodeJS.Platform = 'linux'): ParsedKey {
  const result = parseKeyCombo(combo, platform)
  if ('error' in result) throw new Error(result.error)
  return result
}

describe('parseKeyCombo', () => {
  it('maps named keys to key/code/virtual key code', () => {
    expect(parsed('Enter')).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })
    expect(parsed('backspace')).toMatchObject({ key: 'Backspace', code: 'Backspace', keyCode: 8, modifiers: 0 })
    expect(parsed('Backspace').text).toBeUndefined()
    expect(parsed('ArrowDown')).toMatchObject({ key: 'ArrowDown', keyCode: 40 })
    expect(parsed('Tab')).toMatchObject({ key: 'Tab', keyCode: 9 })
    expect(parsed('Space')).toMatchObject({ key: ' ', code: 'Space', keyCode: 32, text: ' ' })
    expect(parsed(' ')).toMatchObject({ key: ' ', code: 'Space', text: ' ' })
    expect(parsed('F5')).toMatchObject({ key: 'F5', keyCode: 116 })
  })

  it('maps single characters', () => {
    expect(parsed('a')).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })
    expect(parsed('A')).toMatchObject({ key: 'A', code: 'KeyA', keyCode: 65, text: 'A' })
    expect(parsed('7')).toMatchObject({ key: '7', code: 'Digit7', keyCode: 55, text: '7' })
    expect(parsed('#')).toMatchObject({ key: '#', code: 'Digit3', text: '#' })
    expect(parsed('/')).toMatchObject({ code: 'Slash', keyCode: 191, text: '/' })
    expect(parsed('é')).toMatchObject({ key: 'é', code: '', keyCode: 0, text: 'é' })
  })

  it('builds the modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8)', () => {
    expect(MODIFIER_BITS).toEqual({ alt: 1, control: 2, meta: 4, shift: 8 })
    expect(parsed('Control+B').modifiers).toBe(2)
    expect(parsed('Ctrl+b').modifiers).toBe(2)
    expect(parsed('Meta+B').modifiers).toBe(4)
    expect(parsed('Cmd+B').modifiers).toBe(4)
    expect(parsed('Alt+x').modifiers).toBe(1)
    expect(parsed('Option+x').modifiers).toBe(1)
    expect(parsed('Shift+Enter').modifiers).toBe(8)
    expect(parsed('Control+Alt+Meta+Shift+K').modifiers).toBe(15)
  })

  it('treats command combos as shortcuts (no text) but Shift+Enter still inserts', () => {
    const bold = parsed('Control+B')
    expect(bold).toMatchObject({ key: 'b', code: 'KeyB', keyCode: 66 })
    expect(bold.text).toBeUndefined()
    expect(parsed('Shift+Enter')).toMatchObject({ key: 'Enter', text: '\r', modifiers: 8 })
    expect(parsed('Shift+a')).toMatchObject({ key: 'A', text: 'A' })
  })

  it('resolves Mod to Meta on macOS and Control elsewhere', () => {
    expect(parsed('Mod+B', 'darwin').modifiers).toBe(4)
    expect(parsed('Mod+B', 'win32').modifiers).toBe(2)
    expect(parsed('CmdOrCtrl+B', 'linux').modifiers).toBe(2)
  })

  it('adds macOS editing commands for Cmd shortcuts only on darwin', () => {
    expect(parsed('Meta+A', 'darwin').commands).toEqual(['selectAll'])
    expect(parsed('Meta+Shift+Z', 'darwin').commands).toEqual(['redo'])
    expect(parsed('Meta+Z', 'darwin').commands).toEqual(['undo'])
    expect(parsed('Meta+B', 'darwin').commands).toBeUndefined()
    expect(parsed('Meta+A', 'linux').commands).toBeUndefined()
  })

  it('supports the plus key itself', () => {
    expect(parsed('+')).toMatchObject({ key: '+', text: '+' })
    expect(parsed('Control++')).toMatchObject({ key: '+', modifiers: 2 })
  })

  it('rejects unknown keys and modifiers with guidance', () => {
    expect(parseKeyCombo('Hyper+B')).toHaveProperty('error')
    expect(parseKeyCombo('NotAKey')).toHaveProperty('error')
    expect(parseKeyCombo('Control+')).toHaveProperty('error')
    expect(parseKeyCombo('')).toHaveProperty('error')
  })
})

describe('buildFallbackKeyEvents', () => {
  it('maps macOS Cmd editing shortcuts to commands', () => {
    expect(parsed('Meta+A', 'darwin').commands).toEqual(['selectAll'])
    expect(parsed('Meta+Shift+Z', 'darwin').commands).toEqual(['redo'])
    expect(parsed('Meta+B', 'darwin').commands).toBeUndefined()
    expect(parsed('Control+A', 'linux').commands).toBeUndefined()
  })

  it('builds sendInputEvent fallback events with modifier names', () => {
    expect(buildFallbackKeyEvents(parsed('Shift+Enter'))).toEqual([
      { type: 'rawKeyDown', keyCode: 'Enter', modifiers: ['shift'] },
      { type: 'char', keyCode: 'Enter', modifiers: ['shift'] },
      { type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] }
    ])
    expect(buildFallbackKeyEvents(parsed('Control+B')).map((e) => e.type)).toEqual(['rawKeyDown', 'keyUp'])
  })
})

describe('splitTypingSegments', () => {
  it('turns newlines into Enter presses between text runs', () => {
    expect(splitTypingSegments('Title\nFirst para\n\nSecond')).toEqual([
      { kind: 'text', value: 'Title' },
      { kind: 'enter' },
      { kind: 'text', value: 'First para' },
      { kind: 'enter' },
      { kind: 'enter' },
      { kind: 'text', value: 'Second' }
    ])
  })
  it('normalizes CRLF and keeps single-line text as one run', () => {
    expect(splitTypingSegments('a\r\nb')).toEqual([{ kind: 'text', value: 'a' }, { kind: 'enter' }, { kind: 'text', value: 'b' }])
    expect(splitTypingSegments('hello world')).toEqual([{ kind: 'text', value: 'hello world' }])
    expect(splitTypingSegments('')).toEqual([])
  })
})

// ── Guest-bound input: focus guard + verify-after-type ─────────────────────

function fakeGuest(type = 'webview') {
  const log: string[] = []
  const wc = {
    getType: vi.fn(() => type),
    insertText: vi.fn(async (text: string) => { log.push(`insertText:${text}`) }),
    sendInputEvent: vi.fn((ev: Electron.KeyboardInputEvent) => { log.push(`${ev.type}:${ev.keyCode}`) })
  }
  return { wc: wc as GuestInputWebContents & typeof wc, log }
}

/**
 * Simulated panel page with a prepared editor: insertText / key events
 * change its text and trusted-input counter (unless receives=false), and
 * buildEditorStateScript calls read it back.
 */
function simEditor(opts: { focused?: boolean; receives?: boolean; initial?: string; absorbEnter?: boolean; dropLast?: boolean; vanishAfter?: number } = {}) {
  const { wc, log } = fakeGuest()
  const page = { text: opts.initial ?? '', inputs: 0 }
  let reads = 0
  const receives = opts.receives !== false
  wc.insertText.mockImplementation(async (text: string) => {
    log.push(`insertText:${text}`)
    if (!receives) return
    page.inputs++
    if (!(opts.dropLast && text === 'Body')) page.text += text
  })
  wc.sendInputEvent.mockImplementation((ev: Electron.KeyboardInputEvent) => {
    log.push(`${ev.type}:${ev.keyCode}`)
    if (!receives || ev.type !== 'rawKeyDown') return
    if (ev.keyCode === 'Backspace') { page.text = ''; page.inputs++ }
    if (ev.keyCode === 'Enter' && !opts.absorbEnter) { page.text += '\n'; page.inputs++ }
  })
  const evalPage = vi.fn(async (script: string): Promise<Record<string, unknown>> => {
    if (!script.includes('data-bx-type')) { log.push('eval:other'); return { ok: true } }
    reads++
    log.push('eval:state')
    if (opts.vanishAfter !== undefined && reads > opts.vanishAfter) return { found: false }
    return { found: true, focused: opts.focused ?? true, text: page.text, inputs: page.inputs }
  })
  return { wc, log, page, evalPage }
}

const noSleep = async (): Promise<void> => undefined
const sent = (log: string[]): string[] => log.filter((l) => !l.startsWith('eval:'))

describe('guestInputGuard', () => {
  it('only allows <webview> guests', () => {
    expect(guestInputGuard(fakeGuest('webview').wc)).toBeNull()
    for (const type of ['window', 'browserView', 'backgroundPage', 'remote']) {
      expect(guestInputGuard(fakeGuest(type).wc)).toMatch(/not a browser panel/)
    }
    expect(guestInputGuard({ insertText: async () => undefined, sendInputEvent: () => undefined })).toMatch(/not a browser panel/)
    expect(guestInputGuard({ getType: () => { throw new Error('destroyed') } })).toMatch(/not a browser panel/)
  })
})

describe('typeIntoEditor', () => {
  const opts = { marker: 'm1', text: 'Title\nBody', clearFirst: false, submit: false, sleep: noSleep }

  it('refuses a non-webview target without sending anything', async () => {
    const { wc } = fakeGuest('window')
    const evalPage = vi.fn(async () => ({ found: true, focused: true }))
    const result = await typeIntoEditor(wc, evalPage, opts)
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not a browser panel/) })
    expect(evalPage).not.toHaveBeenCalled()
    expect(wc.insertText).not.toHaveBeenCalled()
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
  })

  it('refuses to type when the editor does not hold focus inside the page', async () => {
    const { wc, log, evalPage } = simEditor({ focused: false })
    const result = await typeIntoEditor(wc, evalPage, { ...opts, submit: true })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/did not take keyboard focus/) })
    expect(sent(log)).toEqual([])
    expect(evalPage.mock.calls[0][0]).toContain('addEventListener') // armed the watcher
  })

  it('refuses when the prepared editor is gone', async () => {
    const { wc, log, evalPage } = simEditor({ vanishAfter: 0 })
    expect(await typeIntoEditor(wc, evalPage, opts)).toMatchObject({ ok: false })
    expect(sent(log)).toEqual([])
  })

  it('confirms each step before the next, then presses the submit Enter last', async () => {
    const { wc, log, page, evalPage } = simEditor({ initial: 'old' })
    const result = await typeIntoEditor(wc, evalPage, { ...opts, clearFirst: true, submit: true })
    expect(result).toEqual({ ok: true, input: 'trusted' })
    expect(log).toEqual([
      'eval:state', // focus guard (+ arm the input watcher)
      'rawKeyDown:Backspace', 'keyUp:Backspace', 'eval:state', // clear the selected old content
      'insertText:Title', 'eval:state',
      'rawKeyDown:Enter', 'char:Enter', 'keyUp:Enter', 'eval:state', // new block, confirmed before "Body"
      'insertText:Body', 'eval:state',
      'rawKeyDown:Enter', 'char:Enter', 'keyUp:Enter' // submit, after verification
    ])
    expect(page.text).toBe('Title\nBody\n')
  })

  it('returns ok:false, stops typing and does not submit when the page received nothing', async () => {
    const { wc, log, evalPage } = simEditor({ receives: false, initial: 'same' })
    const result = await typeIntoEditor(wc, evalPage, { ...opts, submit: true })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/did not receive the typed text/) })
    expect(result).not.toHaveProperty('input')
    expect(sent(log)).toEqual(['insertText:Title']) // no Enter, no "Body", no submit
  })

  it('tolerates an Enter the editor absorbs without visible change', async () => {
    const { wc, log, evalPage } = simEditor({ absorbEnter: true })
    expect(await typeIntoEditor(wc, evalPage, opts)).toEqual({ ok: true, input: 'trusted' })
    expect(sent(log)).toContain('insertText:Body')
  })

  it('warns when input arrived but the last typed line is missing', async () => {
    const { wc, evalPage } = simEditor({ dropLast: true })
    const result = await typeIntoEditor(wc, evalPage, opts)
    expect(result).toMatchObject({ ok: true, warning: expect.stringMatching(/does not contain the last typed line/) })
  })

  it('reports page errors and a vanished editor while typing', async () => {
    const { wc, evalPage } = simEditor({ vanishAfter: 1 })
    expect(await typeIntoEditor(wc, evalPage, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/disappeared while typing/) })
    const g = fakeGuest()
    let n = 0
    const errPage = vi.fn(async () => (n++ === 0 ? { found: true, focused: true, text: '', inputs: 0 } : { error: 'navigated' }))
    expect(await typeIntoEditor(g.wc, errPage, opts)).toMatchObject({ ok: false, error: expect.stringContaining('navigated') })
  })
})

describe('buildEditorStateScript', () => {
  function run(script: string, doc: Record<string, unknown>): Record<string, unknown> {
    class FakeNode {}
    return JSON.parse(new Script(script).runInContext(createContext({ document: doc, Node: FakeNode, JSON })) as string)
  }

  it('reports focus only when the active element is the host or inside it', () => {
    const inner = {}
    const host = { innerText: 'abc', contains: (n: unknown) => n === inner || n === host }
    const base = { querySelector: (q: string) => (q === '[data-bx-type="m1"]' ? host : null), addEventListener: () => undefined }
    expect(run(buildEditorStateScript('m1'), { ...base, activeElement: host })).toMatchObject({ found: true, focused: true, text: 'abc', inputs: 0 })
    expect(run(buildEditorStateScript('m1'), { ...base, activeElement: inner })).toMatchObject({ focused: true })
    expect(run(buildEditorStateScript('m1'), { ...base, activeElement: { other: true } })).toMatchObject({ focused: false })
    expect(run(buildEditorStateScript('m1'), { ...base, activeElement: null })).toMatchObject({ focused: false })
    expect(run(buildEditorStateScript('nope'), { ...base, activeElement: host })).toEqual({ found: false })
  })

  it('arms a watcher that counts only trusted input events targeting the host', () => {
    class FakeNode {}
    const host = Object.assign(new FakeNode(), { innerText: '', contains: (n: unknown) => n === host })
    const listeners: Array<(e: unknown) => void> = []
    const doc = { querySelector: () => host, activeElement: host, addEventListener: (_t: string, fn: (e: unknown) => void) => listeners.push(fn) }
    const ctx = createContext({ document: doc, Node: FakeNode, JSON })
    new Script(buildEditorStateScript('m1', true)).runInContext(ctx)
    expect(listeners).toHaveLength(2)
    listeners[0]({ isTrusted: true, target: host })
    listeners[0]({ isTrusted: false, target: host }) // synthetic
    listeners[1]({ isTrusted: true, target: new FakeNode() }) // elsewhere in the page
    expect(JSON.parse(new Script(buildEditorStateScript('m1')).runInContext(ctx) as string)).toMatchObject({ inputs: 1 })
  })
})

describe('pressKeyInGuest', () => {
  it('sends the key to the guest widget only', async () => {
    const { wc, log } = fakeGuest()
    const evalPage = vi.fn(async () => ({ ok: true }))
    expect(await pressKeyInGuest(wc, evalPage, parsed('Control+B'), noSleep)).toEqual({ ok: true, input: 'trusted' })
    expect(log).toEqual(['rawKeyDown:B', 'keyUp:B'])
    expect(evalPage).not.toHaveBeenCalled()
  })

  it('refuses a non-webview target', async () => {
    const { wc } = fakeGuest('window')
    expect(await pressKeyInGuest(wc, vi.fn(async () => ({ ok: true })), parsed('Enter'), noSleep)).toMatchObject({ ok: false })
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
  })

  it('runs the macOS editing command in-page when the page did not handle Cmd+A', async () => {
    const { wc, log } = fakeGuest()
    const evalPage = vi.fn(async (_script: string) => { log.push('eval:other'); return { ok: true } })
    await pressKeyInGuest(wc, evalPage, parsed('Meta+A', 'darwin'), noSleep)
    expect(log).toEqual(['eval:other', 'rawKeyDown:A', 'keyUp:A', 'eval:other'])
    expect(evalPage.mock.calls[1][0]).toContain('document.execCommand("selectAll")')
    expect(evalPage.mock.calls[1][0]).toContain('h !== true')
  })
})

function fakeDebuggerWc(id: number, opts: { attachedByOther?: boolean; attachThrows?: boolean } = {}) {
  let attached = !!opts.attachedByOther
  const listeners = new Map<string, () => void>()
  const dbg = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      if (opts.attachThrows) throw new Error('Another debugger is already attached')
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
    }),
    sendCommand: vi.fn(async () => ({})),
    on: vi.fn((event: string, cb: () => void) => listeners.set(event, cb)),
    removeListener: vi.fn((event: string) => listeners.delete(event))
  }
  const wc = { id, debugger: dbg, sendInputEvent: vi.fn() } as unknown as InputWebContents & { debugger: typeof dbg }
  return {
    wc,
    dbg,
    fireDetach: () => {
      attached = false
      listeners.get('detach')?.()
    }
  }
}

describe('PanelDebuggerSessions', () => {
  it('attaches once and reuses the session', async () => {
    const sessions = new PanelDebuggerSessions()
    const { wc, dbg } = fakeDebuggerWc(1)
    const a = sessions.acquire(wc)
    const b = sessions.acquire(wc)
    expect('send' in a && 'send' in b).toBe(true)
    expect(dbg.attach).toHaveBeenCalledTimes(1)
    sessions.release(1)
    expect(dbg.detach).toHaveBeenCalledTimes(1)
    expect(sessions.isAttached(1)).toBe(false)
  })

  it('refuses the CDP Input domain (it would type into the 20x UI, not the guest)', async () => {
    const sessions = new PanelDebuggerSessions()
    const { wc, dbg } = fakeDebuggerWc(5)
    const session = sessions.acquire(wc)
    if (!('send' in session)) throw new Error('expected a session')
    await expect(session.send('Input.insertText', { text: 'x' })).rejects.toThrow(/not allowed/)
    await expect(session.send('Input.dispatchKeyEvent', { type: 'keyDown' })).rejects.toThrow(/not allowed/)
    expect(dbg.sendCommand).not.toHaveBeenCalled()
    await session.send('DOM.getDocument', { depth: 0 })
    expect(dbg.sendCommand).toHaveBeenCalledWith('DOM.getDocument', { depth: 0 })
  })

  it('reports (does not steal) a debugger attached by someone else', () => {
    const sessions = new PanelDebuggerSessions()
    const { wc, dbg } = fakeDebuggerWc(2, { attachedByOther: true })
    expect(sessions.acquire(wc)).toHaveProperty('error')
    expect(dbg.attach).not.toHaveBeenCalled()
  })

  it('reports attach failures', () => {
    const sessions = new PanelDebuggerSessions()
    const { wc } = fakeDebuggerWc(3, { attachThrows: true })
    const result = sessions.acquire(wc)
    expect(result).toHaveProperty('error')
    if ('error' in result) expect(result.error).toContain('Another debugger')
  })

  it('forgets the session when DevTools (or teardown) detaches it', () => {
    const sessions = new PanelDebuggerSessions()
    const { wc, dbg, fireDetach } = fakeDebuggerWc(4)
    sessions.acquire(wc)
    fireDetach()
    expect(sessions.isAttached(4)).toBe(false)
    sessions.acquire(wc)
    expect(dbg.attach).toHaveBeenCalledTimes(2)
  })
})

describe('resolveUploadPaths', () => {
  const workspace = resolve('/ws/task1')
  const attachments = resolve('/data/attachments/task1')
  const files = new Set([
    join(workspace, 'img.png'),
    join(workspace, 'docs', 'a.pdf'),
    join(attachments, 'logo.jpg'),
    resolve('/etc/passwd')
  ])
  const dirs = new Set([workspace, attachments, join(workspace, 'docs')])
  const links: Record<string, string> = { [join(workspace, 'escape.png')]: resolve('/etc/passwd') }
  const fakeFs: UploadFs = {
    realpath: (p) => {
      const target = links[p] ?? p
      if (!files.has(target) && !dirs.has(target)) throw new Error('ENOENT')
      return target
    },
    isFile: (p) => files.has(p)
  }
  const roots = [workspace, attachments]

  it('accepts files inside the workspace or attachments, relative or absolute', () => {
    expect(resolveUploadPaths(['img.png', join(attachments, 'logo.jpg'), 'docs/a.pdf'], roots, fakeFs)).toEqual({
      ok: true,
      files: [join(workspace, 'img.png'), join(attachments, 'logo.jpg'), join(workspace, 'docs', 'a.pdf')]
    })
  })

  it('accepts a single string path', () => {
    expect(resolveUploadPaths('img.png', roots, fakeFs)).toMatchObject({ ok: true })
  })

  it('rejects path traversal and absolute paths outside the allowed roots', () => {
    expect(resolveUploadPaths(['../../etc/passwd'], roots, fakeFs)).toMatchObject({ ok: false })
    expect(resolveUploadPaths([resolve('/etc/passwd')], roots, fakeFs)).toMatchObject({ ok: false })
    expect(resolveUploadPaths(['docs/../../../etc/passwd'], roots, fakeFs)).toMatchObject({ ok: false })
  })

  it('rejects symlinks that point outside the workspace', () => {
    const r = resolveUploadPaths(['escape.png'], roots, fakeFs)
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.error).toContain('only files inside')
  })

  it('rejects nonexistent files, directories, the root itself and bad input', () => {
    expect(resolveUploadPaths(['missing.png'], roots, fakeFs)).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
    expect(resolveUploadPaths(['docs'], roots, fakeFs)).toMatchObject({ ok: false, error: expect.stringContaining('regular file') })
    expect(resolveUploadPaths(['.'], roots, fakeFs)).toMatchObject({ ok: false })
    expect(resolveUploadPaths([], roots, fakeFs)).toMatchObject({ ok: false })
    expect(resolveUploadPaths([''], roots, fakeFs)).toMatchObject({ ok: false })
    expect(resolveUploadPaths(['a\0b'], roots, fakeFs)).toMatchObject({ ok: false })
    expect(resolveUploadPaths([42], roots, fakeFs)).toMatchObject({ ok: false })
    expect(resolveUploadPaths(Array(MAX_UPLOAD_FILES + 1).fill('img.png'), roots, fakeFs)).toMatchObject({ ok: false })
  })

  it('grants nothing when no root exists', () => {
    expect(resolveUploadPaths(['img.png'], [resolve('/nope')], fakeFs)).toMatchObject({ ok: false })
  })
})
