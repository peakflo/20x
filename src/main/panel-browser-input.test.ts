import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'path'
import {
  buildFallbackKeyEvents,
  buildKeyEvents,
  MAX_UPLOAD_FILES,
  MODIFIER_BITS,
  PanelDebuggerSessions,
  parseKeyCombo,
  resolveUploadPaths,
  splitTypingSegments,
  typeSegmentsCdp,
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

describe('buildKeyEvents', () => {
  it('sends keyDown with text for printable keys and keyUp', () => {
    const events = buildKeyEvents(parsed('Enter'))
    expect(events).toEqual([
      expect.objectContaining({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 0 }),
      expect.objectContaining({ type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 })
    ])
  })

  it('sends rawKeyDown without text for editing keys and shortcuts', () => {
    const [down] = buildKeyEvents(parsed('Backspace'))
    expect(down).toMatchObject({ type: 'rawKeyDown', windowsVirtualKeyCode: 8 })
    expect(down).not.toHaveProperty('text')
    const [bold] = buildKeyEvents(parsed('Meta+B', 'darwin'))
    expect(bold).toMatchObject({ type: 'rawKeyDown', modifiers: 4, windowsVirtualKeyCode: 66 })
    const [selectAll] = buildKeyEvents(parsed('Meta+A', 'darwin'))
    expect(selectAll).toMatchObject({ commands: ['selectAll'] })
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

describe('typeSegmentsCdp', () => {
  it('uses Input.insertText for text and real Enter key events for newlines', async () => {
    const send = vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({}))
    await typeSegmentsCdp(send, splitTypingSegments('line one\nline two'))
    expect(send.mock.calls).toEqual([
      ['Input.insertText', { text: 'line one' }],
      ['Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'Enter', text: '\r' })],
      ['Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp', key: 'Enter' })],
      ['Input.insertText', { text: 'line two' }]
    ])
    // A literal newline is never inserted as text.
    expect(send.mock.calls.some(([, p]) => JSON.stringify(p).includes('\\n'))).toBe(false)
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
  it('attaches once, enables focus emulation and reuses the session', async () => {
    const sessions = new PanelDebuggerSessions()
    const { wc, dbg } = fakeDebuggerWc(1)
    const a = sessions.acquire(wc)
    const b = sessions.acquire(wc)
    expect('send' in a && 'send' in b).toBe(true)
    expect(dbg.attach).toHaveBeenCalledTimes(1)
    expect(dbg.sendCommand).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', { enabled: true })
    sessions.release(1)
    expect(dbg.detach).toHaveBeenCalledTimes(1)
    expect(sessions.isAttached(1)).toBe(false)
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
