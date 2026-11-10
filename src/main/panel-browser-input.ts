/**
 * Trusted input, file upload and screenshot plumbing for agent browser panels.
 *
 * Rich-text editors (Draft.js on x.com, Lexical, ProseMirror, Slate …) keep
 * their own document model and only update it from *trusted* input:
 * `beforeinput` / `textInput` / real `keydown`. Script-made changes
 * (`el.textContent = …`, synthetic `new KeyboardEvent()` with isTrusted=false)
 * reach the DOM but never the editor model, so the editor reverts or drops
 * them on its next render. The helpers here drive the page through the
 * panel's own `webContents.debugger` (Chrome DevTools Protocol), which
 * produces exactly the events a real keyboard does.
 *
 * Why CDP over `webContents.sendInputEvent`:
 *  - sendInputEvent requires the hosting BrowserWindow to be focused
 *    (Electron docs), which an agent-driven, usually unfocused panel is not.
 *  - CDP has `Input.insertText` (IME-commit path: fires beforeinput +
 *    textInput, which React's onBeforeInput and Draft.js listen to), focus
 *    emulation for background panels, `DOM.setFileInputFiles` for uploads and
 *    `Page.captureScreenshot` as a screenshot fallback.
 * sendInputEvent is still used as a fallback when the debugger cannot be
 * attached (e.g. the user opened DevTools on the panel).
 *
 * Safety: the debugger is attached in-process to a single registered panel
 * webContents — no remote-debugging port is opened, the main window is never
 * attached, and agents cannot send arbitrary CDP methods (only the fixed
 * commands below are used).
 */
import { realpathSync, statSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'

// ── Key parsing ─────────────────────────────────────────────────────────────

/** CDP Input.dispatchKeyEvent modifier bitmask. */
export const MODIFIER_BITS = { alt: 1, control: 2, meta: 4, shift: 8 } as const
type ModifierName = keyof typeof MODIFIER_BITS

const MODIFIER_ALIASES: Record<string, ModifierName | 'mod'> = {
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  ctrl: 'control',
  control: 'control',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  shift: 'shift',
  // Platform "primary" modifier: Meta on macOS, Control elsewhere.
  mod: 'mod',
  cmdorctrl: 'mod',
  commandorcontrol: 'mod'
}

interface KeyDef {
  key: string
  code: string
  keyCode: number
  /** Text the key produces when no command modifier is held. */
  text?: string
  /** Electron accelerator name for the sendInputEvent fallback. */
  accelerator: string
}

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', accelerator: 'Enter' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', accelerator: 'Enter' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, accelerator: 'Tab' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27, accelerator: 'Escape' },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27, accelerator: 'Escape' },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, accelerator: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46, accelerator: 'Delete' },
  del: { key: 'Delete', code: 'Delete', keyCode: 46, accelerator: 'Delete' },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45, accelerator: 'Insert' },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ', accelerator: 'Space' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, accelerator: 'Up' },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, accelerator: 'Up' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, accelerator: 'Down' },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, accelerator: 'Down' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, accelerator: 'Left' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, accelerator: 'Left' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, accelerator: 'Right' },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, accelerator: 'Right' },
  home: { key: 'Home', code: 'Home', keyCode: 36, accelerator: 'Home' },
  end: { key: 'End', code: 'End', keyCode: 35, accelerator: 'End' },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33, accelerator: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34, accelerator: 'PageDown' }
}
for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i, accelerator: `F${i}` }
}

/** US-layout punctuation: [unshifted, shifted, code, windowsVirtualKeyCode]. */
const PUNCTUATION: Array<[string, string, string, number]> = [
  ['-', '_', 'Minus', 189],
  ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219],
  [']', '}', 'BracketRight', 221],
  ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186],
  ["'", '"', 'Quote', 222],
  [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190],
  ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192]
]
const SHIFTED_DIGITS = ')!@#$%^&*('

function charKeyDef(ch: string, shift: boolean): KeyDef {
  if (/^[a-z]$/i.test(ch)) {
    const upper = ch.toUpperCase()
    const key = shift ? upper : ch.toLowerCase()
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key, accelerator: upper }
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, accelerator: ch }
  }
  const shiftedDigit = SHIFTED_DIGITS.indexOf(ch)
  if (shiftedDigit >= 0) {
    return { key: ch, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: ch, accelerator: ch }
  }
  for (const [plain, shifted, code, keyCode] of PUNCTUATION) {
    if (ch === plain || ch === shifted) {
      const key = shift ? shifted : ch
      return { key, code, keyCode, text: key, accelerator: ch === '+' ? 'Plus' : ch }
    }
  }
  // Any other single character (é, #, emoji …): no physical key, text only.
  return { key: ch, code: '', keyCode: 0, text: ch, accelerator: ch }
}

export interface ParsedKey {
  key: string
  code: string
  keyCode: number
  /** Text inserted by the key (undefined for non-printing keys / command combos). */
  text?: string
  /** CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
  modifiers: number
  modifierNames: ModifierName[]
  /** macOS editing commands (CDP `commands`) — Cmd+A etc. need them on mac. */
  commands?: string[]
  accelerator: string
}

const MAC_COMMANDS: Record<string, string> = {
  KeyA: 'selectAll',
  KeyZ: 'undo',
  KeyX: 'cut',
  KeyC: 'copy',
  KeyV: 'paste'
}

/**
 * Parses "Enter", "a", "Control+B", "Meta+Shift+Z", "Shift+Enter", "Mod+B"
 * into CDP key-event data. Returns an error message for unknown keys.
 */
export function parseKeyCombo(input: string, platform: NodeJS.Platform = process.platform): ParsedKey | { error: string } {
  const raw = typeof input === 'string' ? input : ''
  if (!raw) return { error: 'key is required' }
  // A bare "+" or a trailing "++" means the plus key itself.
  const parts = raw === '+' ? ['+'] : raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+')
  if (parts.some((p) => p === '')) return { error: `Malformed key combination "${raw}"` }
  const keyPart = parts[parts.length - 1]
  const modifierNames = new Set<ModifierName>()
  for (const part of parts.slice(0, -1)) {
    const alias = MODIFIER_ALIASES[part.trim().toLowerCase()]
    if (!alias) return { error: `Unknown modifier "${part}" in "${raw}" — use Control, Meta, Alt, Shift or Mod` }
    modifierNames.add(alias === 'mod' ? (platform === 'darwin' ? 'meta' : 'control') : alias)
  }
  const shift = modifierNames.has('shift')
  const named = keyPart === ' ' ? NAMED_KEYS.space : keyPart.length > 1 ? NAMED_KEYS[keyPart.trim().toLowerCase()] : undefined
  let def: KeyDef | undefined = named
  if (!def && [...keyPart].length === 1) def = charKeyDef(keyPart, shift)
  if (!def) {
    return { error: `Unsupported key "${keyPart}" — use Enter, Tab, Escape, Backspace, Delete, Space, Arrow keys, Home, End, PageUp, PageDown, F1-F12, a single character, or combos like "Control+B" / "Meta+Shift+Z" / "Shift+Enter".` }
  }
  // A shifted single letter typed without "Shift+" (e.g. "B") is just that character.
  if (!named && /^[A-Z]$/.test(keyPart) && modifierNames.size === 0) def = { ...def, key: keyPart, text: keyPart }
  let modifiers = 0
  for (const name of modifierNames) modifiers |= MODIFIER_BITS[name]
  // Ctrl/Meta/Alt combos are commands, not text input (Shift+Enter still
  // inserts — editors use it for a soft line break).
  const commandHeld = modifierNames.has('control') || modifierNames.has('meta') || modifierNames.has('alt')
  const text = commandHeld ? undefined : def.text
  const ordered = (['alt', 'control', 'meta', 'shift'] as ModifierName[]).filter((m) => modifierNames.has(m))
  const result: ParsedKey = { key: def.key, code: def.code, keyCode: def.keyCode, text, modifiers, modifierNames: ordered, accelerator: def.accelerator }
  if (platform === 'darwin' && modifierNames.has('meta') && !modifierNames.has('control') && !modifierNames.has('alt')) {
    const cmd = def.code === 'KeyZ' && shift ? 'redo' : MAC_COMMANDS[def.code]
    if (cmd) result.commands = [cmd]
  }
  return result
}

/** CDP Input.dispatchKeyEvent params for one key press (down + up). */
export function buildKeyEvents(k: ParsedKey): Array<Record<string, unknown>> {
  const base = {
    modifiers: k.modifiers,
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode
  }
  const down: Record<string, unknown> = {
    ...base,
    // keyDown with text = keydown + keypress/char (+ beforeinput/textInput);
    // rawKeyDown = keydown only (editing/navigation keys, shortcuts).
    type: k.text ? 'keyDown' : 'rawKeyDown',
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    ...(k.commands ? { commands: k.commands } : {})
  }
  return [down, { ...base, type: 'keyUp' }]
}

/** Electron sendInputEvent sequence for one key press (fallback path). */
export function buildFallbackKeyEvents(k: ParsedKey): Electron.KeyboardInputEvent[] {
  const modifiers = k.modifierNames as Electron.KeyboardInputEvent['modifiers']
  const events: Electron.KeyboardInputEvent[] = [{ type: 'rawKeyDown', keyCode: k.accelerator, modifiers }]
  if (k.text) events.push({ type: 'char', keyCode: k.text === '\r' ? 'Enter' : k.text, modifiers })
  events.push({ type: 'keyUp', keyCode: k.accelerator, modifiers })
  return events
}

// ── Typing ──────────────────────────────────────────────────────────────────

export type TypingSegment = { kind: 'text'; value: string } | { kind: 'enter' }

/**
 * Splits text into insertText runs and real Enter presses. A literal "\n"
 * inserted as text becomes a soft break (or is dropped) in block editors;
 * a trusted Enter makes them split the block into a new paragraph.
 */
export function splitTypingSegments(text: string): TypingSegment[] {
  const out: TypingSegment[] = []
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  lines.forEach((line, i) => {
    if (i > 0) out.push({ kind: 'enter' })
    if (line) out.push({ kind: 'text', value: line })
  })
  return out
}

// ── Debugger sessions ───────────────────────────────────────────────────────

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Minimal slice of Electron.WebContents used here (mockable in tests). */
export interface InputWebContents {
  id: number
  debugger: Pick<Electron.Debugger, 'attach' | 'detach' | 'isAttached' | 'sendCommand' | 'on' | 'removeListener'>
  sendInputEvent: (event: Electron.KeyboardInputEvent) => void
}

/**
 * Keeps one CDP session per panel webContents, attached lazily on first use
 * and kept for the panel's lifetime (re-attaching per command would toggle
 * page focus emulation and blur the editor between commands).
 */
export class PanelDebuggerSessions {
  private attached = new Map<number, { wc: InputWebContents; onDetach: () => void }>()

  /** Returns a sender, or an error string when the debugger is unavailable. */
  acquire(wc: InputWebContents): { send: CdpSend } | { error: string } {
    const dbg = wc.debugger
    if (!this.attached.has(wc.id)) {
      if (dbg.isAttached()) return { error: 'Another debugger is attached to this panel (DevTools open?)' }
      try {
        dbg.attach('1.3')
      } catch (err) {
        return { error: `Could not attach to the panel: ${(err as Error).message}` }
      }
      const onDetach = (): void => {
        this.attached.delete(wc.id)
        dbg.removeListener('detach', onDetach)
      }
      dbg.on('detach', onDetach)
      this.attached.set(wc.id, { wc, onDetach })
      // Background panels: make the page behave as focused so caret, focus
      // and keyboard routing work while the panel is not the active widget.
      void dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
    }
    return { send: (method, params) => dbg.sendCommand(method, params ?? {}) }
  }

  release(webContentsId: number): void {
    const entry = this.attached.get(webContentsId)
    if (!entry) return
    this.attached.delete(webContentsId)
    entry.wc.debugger.removeListener('detach', entry.onDetach)
    try {
      entry.wc.debugger.detach()
    } catch {
      // Already detached (webContents destroyed or DevTools took over).
    }
  }

  isAttached(webContentsId: number): boolean {
    return this.attached.has(webContentsId)
  }
}

/** Sends one key press through CDP. */
export async function pressKeyCdp(send: CdpSend, k: ParsedKey): Promise<void> {
  for (const event of buildKeyEvents(k)) await send('Input.dispatchKeyEvent', event)
}

const ENTER = parseKeyCombo('Enter') as ParsedKey
const BACKSPACE = parseKeyCombo('Backspace') as ParsedKey

export { ENTER as ENTER_KEY, BACKSPACE as BACKSPACE_KEY }

/** Types segments with trusted input: Input.insertText per run, real Enter between lines. */
export async function typeSegmentsCdp(send: CdpSend, segments: TypingSegment[]): Promise<void> {
  for (const seg of segments) {
    if (seg.kind === 'enter') await pressKeyCdp(send, ENTER)
    else await send('Input.insertText', { text: seg.value })
  }
}

/** Fallback typing via sendInputEvent (needs the window focused). */
export function typeSegmentsFallback(wc: Pick<InputWebContents, 'sendInputEvent'>, segments: TypingSegment[]): void {
  for (const seg of segments) {
    if (seg.kind === 'enter') {
      for (const ev of buildFallbackKeyEvents(ENTER)) wc.sendInputEvent(ev)
    } else {
      for (const ch of seg.value) wc.sendInputEvent({ type: 'char', keyCode: ch })
    }
  }
}

// ── Upload path validation ─────────────────────────────────────────────────

export const MAX_UPLOAD_FILES = 20

export interface UploadFs {
  realpath: (p: string) => string
  isFile: (p: string) => boolean
}

const nodeFs: UploadFs = {
  realpath: (p) => realpathSync(p),
  isFile: (p) => statSync(p).isFile()
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/**
 * Resolves agent-supplied upload paths and enforces that every file is a
 * regular file inside one of `allowedRoots` (the task workspace and its
 * attachments dir). Relative paths resolve against the first root. Symlinks
 * are resolved before the containment check, so a link pointing outside the
 * workspace is rejected like a "../" traversal.
 */
export function resolveUploadPaths(
  paths: unknown,
  allowedRoots: string[],
  fsImpl: UploadFs = nodeFs
): { ok: true; files: string[] } | { ok: false; error: string } {
  const list = typeof paths === 'string' ? [paths] : paths
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'paths must be a non-empty array of file paths' }
  if (list.length > MAX_UPLOAD_FILES) return { ok: false, error: `At most ${MAX_UPLOAD_FILES} files per upload` }
  const roots: string[] = []
  for (const root of allowedRoots) {
    try {
      roots.push(fsImpl.realpath(root))
    } catch {
      // A missing root simply grants nothing.
    }
  }
  if (roots.length === 0) return { ok: false, error: 'No upload directory is available for this task' }
  const files: string[] = []
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return { ok: false, error: 'Each path must be a non-empty string' }
    const candidate = isAbsolute(p) ? resolve(p) : resolve(roots[0], p)
    let real: string
    try {
      real = fsImpl.realpath(candidate)
    } catch {
      return { ok: false, error: `File not found: ${p}` }
    }
    if (!roots.some((root) => isInside(root, real))) {
      return { ok: false, error: `Refusing to upload "${p}": only files inside the task workspace or its attachments can be uploaded` }
    }
    let file = false
    try {
      file = fsImpl.isFile(real)
    } catch {
      file = false
    }
    if (!file) return { ok: false, error: `Not a regular file: ${p}` }
    files.push(real)
  }
  return { ok: true, files }
}
