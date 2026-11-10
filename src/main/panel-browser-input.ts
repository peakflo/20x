/**
 * Trusted input, file upload and screenshot plumbing for agent browser panels.
 *
 * Rich-text editors (Draft.js on x.com, Lexical, ProseMirror, Slate …) keep
 * their own document model and only update it from *trusted* input:
 * `beforeinput` / `textInput` / real `keydown`. Script-made changes
 * (`el.textContent = …`, synthetic `new KeyboardEvent()` with isTrusted=false)
 * reach the DOM but never the editor model.
 *
 * Keyboard input goes ONLY through the guest webContents' own
 * `insertText()` (IME-commit path: trusted beforeinput + textInput) and
 * `sendInputEvent()` (trusted keydown/char/keyup). Electron forwards both to
 * the guest's render widget, so they reach the panel page even while the
 * 20x window is unfocused or the user is typing in the app.
 *
 * NEVER use the CDP Input domain (Input.insertText / Input.dispatchKeyEvent)
 * on a panel: for a <webview> guest Chromium routes those to the focused
 * widget of the *embedder* — i.e. whatever is focused in the 20x UI (the
 * agent chat box), not the guest page — even with focus emulation enabled
 * or after guest.focus(). That leaked agent keystrokes into the app and sent
 * chat messages. PanelDebuggerSessions rejects Input.* methods to keep it so.
 *
 * The debugger is still used for DOM.setFileInputFiles (uploads) and
 * Page.captureScreenshot. It is attached in-process to a single registered
 * panel webContents — no remote-debugging port, never the main window, and
 * agents cannot send arbitrary CDP methods.
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

/** Electron sendInputEvent sequence for one key press (down [+ char] + up). */
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

// ── Debugger sessions (uploads + screenshot fallback only) ─────────────────

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Minimal slice of Electron.WebContents used here (mockable in tests). */
export interface InputWebContents {
  id: number
  debugger: Pick<Electron.Debugger, 'attach' | 'detach' | 'isAttached' | 'sendCommand' | 'on' | 'removeListener'>
}

/**
 * Keeps one CDP session per panel webContents, attached lazily on first use
 * and kept for the panel's lifetime. Used ONLY for DOM.setFileInputFiles and
 * Page.captureScreenshot — never for the Input domain (see the module header).
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
    }
    return {
      send: (method, params) => {
        // Defense in depth: the Input domain of a <webview> guest's debugger
        // targets the embedder's focused widget — it must never be used.
        if (method.startsWith('Input.')) return Promise.reject(new Error(`${method} is not allowed on panel debuggers`))
        return dbg.sendCommand(method, params ?? {})
      }
    }
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

// ── Guest-bound input delivery ──────────────────────────────────────────────

/** Minimal slice of Electron.WebContents used to deliver input to a panel guest. */
export interface GuestInputWebContents {
  getType: () => string
  insertText: (text: string) => Promise<void>
  sendInputEvent: (event: Electron.KeyboardInputEvent) => void
}

/** Runs a script in the panel page and returns its parsed result. */
export type PageEval = (script: string) => Promise<Record<string, unknown>>

/**
 * Input may only be delivered to a <webview> guest. Its own
 * `insertText` / `sendInputEvent` go to the guest's render widget; anything
 * else (a BrowserWindow, the main app window) is refused outright.
 */
export function guestInputGuard(wc: Partial<GuestInputWebContents>): string | null {
  let type = ''
  try {
    type = typeof wc.getType === 'function' ? wc.getType() : ''
  } catch {
    type = ''
  }
  if (type !== 'webview') return 'Refusing to send keyboard input: the target is not a browser panel (<webview>).'
  if (typeof wc.insertText !== 'function' || typeof wc.sendInputEvent !== 'function') return 'Keyboard input is unavailable for this panel.'
  return null
}

/** Sends one key press to the guest's own widget. */
export function sendKeyToGuest(wc: Pick<GuestInputWebContents, 'sendInputEvent'>, k: ParsedKey): void {
  for (const ev of buildFallbackKeyEvents(k)) wc.sendInputEvent(ev)
}

const ENTER = parseKeyCombo('Enter') as ParsedKey
const BACKSPACE = parseKeyCombo('Backspace') as ParsedKey

export { ENTER as ENTER_KEY, BACKSPACE as BACKSPACE_KEY }

/**
 * Reads the editing host tagged `data-bx-type="<marker>"` by buildTypeScript:
 * whether it holds keyboard focus inside the page, its text, and how many
 * trusted beforeinput/input events reached it since `arm`.
 */
export function buildEditorStateScript(marker: string, arm = false): string {
  return `(() => {
  const host = document.querySelector(${JSON.stringify(`[data-bx-type="${marker}"]`)});
  if (!host) return JSON.stringify({ found: false });
  const a = document.activeElement;
  const focused = !!a && (a === host || host.contains(a));
  if (${arm ? 'true' : 'false'}) {
    const w = { count: 0 };
    w.fn = (e) => { if (e.isTrusted && e.target instanceof Node && host.contains(e.target)) w.count++; };
    document.addEventListener('beforeinput', w.fn, true);
    document.addEventListener('input', w.fn, true);
    host.__bxTypeWatch = w;
  }
  const w = host.__bxTypeWatch;
  return JSON.stringify({ found: true, focused, text: host.innerText || '', inputs: w ? w.count : 0 });
})()`
}

/** Removes the marker and the input watcher installed by buildEditorStateScript. */
export function buildEditorCleanupScript(marker: string): string {
  return `(() => {
  for (const host of document.querySelectorAll(${JSON.stringify(`[data-bx-type="${marker}"]`)})) {
    const w = host.__bxTypeWatch;
    if (w) { document.removeEventListener('beforeinput', w.fn, true); document.removeEventListener('input', w.fn, true); delete host.__bxTypeWatch; }
    host.removeAttribute('data-bx-type');
  }
  return JSON.stringify({ ok: true });
})()`
}

const normalizeText = (s: string): string => s.replace(/\s+/g, ' ').trim()

export interface TypeIntoEditorOptions {
  marker: string
  text: string
  clearFirst: boolean
  submit: boolean
  /** Delay helper (injectable for tests). */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Types into the contenteditable host prepared by buildTypeScript.
 *
 *  1. Guard: the target is a <webview> guest and the host holds focus inside
 *     the page — otherwise nothing is sent.
 *  2. Delivery through the guest's own widget (insertText / sendInputEvent).
 *     insertText and key events travel on different channels, so each step
 *     waits until the page reflects it before the next one is sent (else
 *     Enter presses overtake the text and lines end up merged).
 *  3. Verify: every text run must reach the host (trusted input events or a
 *     text change) — otherwise stop and return ok:false, never a silent ok.
 *  4. submit's Enter is pressed only after all text was verified.
 */
export async function typeIntoEditor(
  wc: GuestInputWebContents,
  evalPage: PageEval,
  opts: TypeIntoEditorOptions
): Promise<Record<string, unknown>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const guardError = guestInputGuard(wc)
  if (guardError) return { ok: false, error: guardError }
  const before = await evalPage(buildEditorStateScript(opts.marker, true))
  if (before.error) return { ok: false, error: String(before.error) }
  if (before.found !== true) return { ok: false, error: 'The editor disappeared before typing — run browser_snapshot again.' }
  if (before.focused !== true) {
    return { ok: false, error: 'The editor did not take keyboard focus inside the page, so nothing was typed. Click it with browser_click and retry.' }
  }
  let last = { inputs: Number(before.inputs) || 0, text: String(before.text ?? '') }
  /** Polls until the page shows progress; null = no progress within ~300ms. */
  const settle = async (): Promise<Record<string, unknown> | null> => {
    for (let i = 0; i < 12; i++) {
      await sleep(25)
      const state = await evalPage(buildEditorStateScript(opts.marker))
      if (state.error || state.found !== true) return state
      const next = { inputs: Number(state.inputs) || 0, text: String(state.text ?? '') }
      if (next.inputs > last.inputs || next.text !== last.text) {
        last = next
        return state
      }
    }
    return null
  }
  const lost = (state: Record<string, unknown>): Record<string, unknown> =>
    state.error
      ? { ok: false, error: `Could not verify typing: ${String(state.error)}` }
      : { ok: false, error: 'The editor disappeared while typing; the text may be incomplete. Check with browser_snapshot.' }

  const segments = splitTypingSegments(opts.text)
  try {
    if (opts.clearFirst) {
      sendKeyToGuest(wc, BACKSPACE)
      const state = await settle()
      if (state && (state.error || state.found !== true)) return lost(state)
    }
    for (const seg of segments) {
      if (seg.kind === 'enter') sendKeyToGuest(wc, ENTER)
      else await wc.insertText(seg.value)
      const state = await settle()
      if (state && (state.error || state.found !== true)) return lost(state)
      // A text run must visibly arrive; Enter may legitimately be absorbed.
      if (!state && seg.kind === 'text') {
        return { ok: false, error: 'The page did not receive the typed text (no input events, content unchanged). Typing stopped and nothing was submitted. Click the editor with browser_click and retry.' }
      }
    }
  } catch (err) {
    return { ok: false, error: `Typing failed: ${(err as Error)?.message ?? String(err)}` }
  }
  const result: Record<string, unknown> = { ok: true, input: 'trusted' }
  const lastLine = [...segments].reverse().find((s) => s.kind === 'text') as { value: string } | undefined
  if (lastLine && !normalizeText(last.text).includes(normalizeText(lastLine.value))) {
    result.warning = 'The editor received input but its text does not contain the last typed line; it may have reformatted or rejected part of it. Verify with browser_snapshot.'
  }
  if (opts.submit) sendKeyToGuest(wc, ENTER)
  return result
}

/**
 * Presses a key in the guest. On macOS, Cmd+A/Z/X/C/V are editing commands
 * (NSResponder selectors) that a raw key event does not trigger, so when the
 * page did not handle the keydown itself, run the matching command in-page.
 */
export async function pressKeyInGuest(
  wc: GuestInputWebContents,
  evalPage: PageEval,
  k: ParsedKey,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms))
): Promise<Record<string, unknown>> {
  const guardError = guestInputGuard(wc)
  if (guardError) return { ok: false, error: guardError }
  const command = k.commands?.[0]
  if (command) {
    const armed = await evalPage(`(() => { window.__bxKeyHandled = undefined; window.addEventListener('keydown', (e) => { window.__bxKeyHandled = e.defaultPrevented; }, { once: true }); return JSON.stringify({ ok: true }); })()`)
    if (armed.error) return { ok: false, error: String(armed.error) }
  }
  sendKeyToGuest(wc, k)
  if (command) {
    await sleep(50)
    await evalPage(`(() => { const h = window.__bxKeyHandled; delete window.__bxKeyHandled; if (h !== true) document.execCommand(${JSON.stringify(command)}); return JSON.stringify({ ok: true }); })()`)
  }
  return { ok: true, input: 'trusted' }
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
