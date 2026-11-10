/**
 * Panel Browser Broker.
 *
 * Lets agent sessions drive the canvas browser panels (<webview>) through
 * `browser_*` MCP tools served by the Task API server, with two hard
 * guarantees that the previous agent-browser + global CDP port integration
 * could not give:
 *
 *  1. The main app window is unreachable. Panels must be registered here
 *     explicitly (the renderer registers each browser panel with the task ids
 *     it is edge-connected to), and only registered panels can be addressed.
 *     Nothing else — including the main window — is ever exposed, and there is
 *     no debug port to enumerate targets from.
 *  2. Addressing is exact and stable. Commands name a canvas panelId (auto-
 *     bound when exactly one browser panel is linked to the calling task), so
 *     there are no positional tab indexes to go stale.
 *
 * Reads and DOM queries run on plain Electron APIs (loadURL /
 * executeJavaScript / capturePage). Typing into rich-text editors and key
 * presses need *trusted* input: they go through the guest webContents' own
 * insertText / sendInputEvent, which are bound to the guest page (never the
 * CDP Input domain, which leaks to the 20x UI — see panel-browser-input.ts).
 * File uploads use the panel's in-process `webContents.debugger` — still no
 * remote-debugging port, and only registered panels are attached.
 *
 * Every agent-supplied string is embedded in page scripts as a JSON literal
 * (JSON.stringify) — never spliced into script source — so it is data, not code.
 */
import { app, webContents } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  buildEditorCleanupScript,
  PanelDebuggerSessions,
  parseKeyCombo,
  pressKeyInGuest,
  typeIntoEditor,
  type CdpSend,
  type GuestInputWebContents,
  type InputWebContents
} from './panel-browser-input'
import { BrowserRecordingService } from './browser-recording'
import { getAgentBrowserSession } from './agent-browser-session'
import { buildRecordingInstallScript, buildRecordingSnapshotScript, buildRecordingTargetScript, RECORDING_PREFIX, RECORDING_REMOVE_SCRIPT, RECORDING_WORLD } from './browser-recording-scripts'
import type { BrowserRecordingResult, BrowserRecordingSnapshot, BrowserRecordingStep } from '../shared/browser-recording'

// ── Pure helpers (unit-tested without Electron) ─────────────────────────────

export interface RegisteredPanel {
  webContentsId: number
  taskIds: Set<string>
}

export type PanelRegistry = Map<string, RegisteredPanel>

export interface ResolvedPanel {
  ok: true
  panelId: string
}

export interface PanelResolutionError {
  ok: false
  error: string
}

/**
 * Picks which panel a command may act on. With an explicit panel_id it must
 * exist AND be linked to the calling task. Without one, auto-binds when
 * exactly one panel is linked to the task; ambiguity is an error, not a guess.
 */
export function resolvePanelForTask(
  registry: PanelRegistry,
  taskId: string,
  panelId?: string | null
): ResolvedPanel | PanelResolutionError {
  if (!(registry instanceof Map)) return { ok: false, error: 'Broker registry unavailable' }

  if (panelId) {
    const panel = registry.get(panelId)
    if (!panel) {
      return { ok: false, error: `Unknown browser panel "${panelId}". Use browser_list_panels.` }
    }
    if (!panel.taskIds.has(taskId)) {
      return { ok: false, error: `Browser panel "${panelId}" is not linked to this task. Use browser_list_panels.` }
    }
    return { ok: true, panelId }
  }

  const linked = [...registry.entries()].filter(([, p]) => p.taskIds.has(taskId))
  if (linked.length === 0) {
    return { ok: false, error: 'No browser panel is linked to this task. Connect one on the canvas (globe handle on the task panel).' }
  }
  if (linked.length > 1) {
    const list = linked.map(([id]) => id).join(', ')
    return { ok: false, error: `Multiple browser panels are linked to this task (${list}). Pass panel_id.` }
  }
  return { ok: true, panelId: linked[0][0] }
}

/** Normalizes "@e12" / "e12" ref values to their element attribute value. */
export function normalizeRef(ref: string): string {
  return ref.startsWith('@') ? ref.slice(1) : ref
}

/** Keeps useful command targets while avoiding common secret-bearing selectors. */
export function sanitizeRecordingTarget(target: string): string {
  const compact = target.trim().replace(/\s+/g, ' ')
  if (/password|secret|token|auth|credit|card|cvv|cvc|ssn|otp|one.time|verification|pin/i.test(compact)) return '[sensitive selector]'
  if (/(?:Bearer\s+)?[a-zA-Z0-9_-]{32,}/.test(compact)) return '[sensitive selector]'
  return compact.slice(0, 160)
}

const SNAPSHOT_ELEMENT_CAP = 120

/**
 * Builds the injected script behind browser_snapshot: labels every visible
 * interactive element with data-bx-ref="eN" and returns a compact JSON line
 * per element — the same @ref ergonomics agents know from agent-browser.
 */
export function buildSnapshotScript(): string {
  return `(() => {
  const SEL = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=switch],[onclick],[contenteditable=true],summary';
  const sensitive = (el) => /password|secret|token|auth|credit|card|cvv|cvc|ssn|otp|one.time|verification|pin/i.test([el.type, el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '));
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= ${SNAPSHOT_ELEMENT_CAP}) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    const ref = 'e' + (++i);
    el.setAttribute('data-bx-ref', ref);
    out.push({
      ref,
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      value: ['INPUT','SELECT','TEXTAREA'].includes(el.tagName) ? (sensitive(el) || el.type === 'file' ? '[redacted]' : String(el.value ?? '').slice(0, 60)) : undefined,
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 120) : undefined
    });
  }
  return JSON.stringify({ url: location.href, title: document.title, elements: out });
})()`
}

export interface SnapshotElement {
  ref: string
  role: string
  name?: string
  value?: string
  href?: string
}

export interface SnapshotResult {
  url: string
  title: string
  elements: SnapshotElement[]
}

/** Parses the payload returned by buildSnapshotScript() — object or JSON string. */
export function parseSnapshotResult(raw: unknown): SnapshotResult | { error: string } {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { error: 'Malformed snapshot payload' }
    }
  }
  const snap = parsed as SnapshotResult | null
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.elements)) {
    return { error: 'Malformed snapshot payload' }
  }
  return snap
}

function queryFor(refOrSelector: string): string {
  const looksLikeRef = /^@?e\d+$/.test(refOrSelector.trim())
  if (!looksLikeRef) {
    // Treat anything else as a CSS selector.
    return JSON.stringify(refOrSelector)
  }
  return JSON.stringify(`[data-bx-ref="${normalizeRef(refOrSelector.trim())}"]`)
}

/**
 * In-page statement that returns `{ error: 'Invalid selector: …' }` from the
 * enclosing script when the CSS selector does not parse. Without it
 * querySelector throws a DOMException, which executeJavaScript cannot
 * serialize — the agent got a bare `{}` with no message.
 */
export function selectorGuard(refOrSelector: string): string {
  if (/^@?e\d+$/.test(refOrSelector.trim())) return ''
  return `try { document.createDocumentFragment().querySelector(${JSON.stringify(refOrSelector)}); } catch (err) { if (err && err.name === 'SyntaxError') return JSON.stringify({ error: 'Invalid selector: ' + ${JSON.stringify(refOrSelector)} }); }`
}

/** Best-effort message for an executeJavaScript rejection (not always an Error). */
export function evalErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string' && (err as Error).message) {
    return (err as Error).message
  }
  if (typeof err === 'string' && err) return err
  return 'The page script failed (the page threw a non-serializable error).'
}

/** Clicks a snapshot ref (or CSS selector), scrolling it into view first. */
export function buildClickScript(refOrSelector: string): string {
  return `(async () => {
  ${selectorGuard(refOrSelector)}
  const el = document.querySelector(${queryFor(refOrSelector)});
  if (!el) return JSON.stringify({ error: 'Stale or unknown target ' + JSON.stringify(${JSON.stringify(refOrSelector)}) + ' — run browser_snapshot again.' });
  el.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 50));
  el.click();
  return JSON.stringify({ ok: true });
})()`
}

/**
 * Focuses the target and fills it.
 *
 * input / textarea / select: sets the value through the native setter with
 * React-compatible input/change events (works for controlled inputs).
 *
 * contenteditable (Draft.js, Lexical, ProseMirror …): only focuses the
 * editing host and places the selection (all content when `clear`, else the
 * caret at the end unless it is already inside). It returns
 * `{ trusted: true }` and the broker then types with trusted guest input (typeIntoEditor) —
 * editors ignore script-made DOM edits and isTrusted=false events.
 */
export function buildTypeScript(refOrSelector: string, text: string, submit?: boolean, clear = true, marker?: string): string {
  return `(async () => {
  ${selectorGuard(refOrSelector)}
  const target = ${JSON.stringify(refOrSelector)};
  let el = document.querySelector(${queryFor(refOrSelector)});
  if (!el) return JSON.stringify({ error: 'Stale or unknown target — run browser_snapshot again.' });
  const tag = el.tagName;
  if (tag === 'SELECT') {
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if ((tag === 'INPUT' || tag === 'TEXTAREA') && !el.readOnly) {
    el.focus();
    const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, ${JSON.stringify(text)});
    else el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // A wrapper (e.g. a composer container) may hold the editable element.
    if (!el.isContentEditable) el = el.querySelector('[contenteditable]:not([contenteditable=false])') || el;
    if (!el.isContentEditable) {
      // Not an editable element (e.g. a link or button was passed): report
      // instead of throwing "Illegal invocation" from the native value setter.
      return JSON.stringify({ error: 'Target ' + JSON.stringify(target) + ' is not an editable element (role: ' + (el.getAttribute('role') || tag.toLowerCase()) + '). Pick an input/textarea/contenteditable ref from browser_snapshot.' });
    }
    let host = el;
    while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
    host.scrollIntoView({ block: 'center' });
    host.focus();
    const sel = window.getSelection();
    const inside = sel && sel.rangeCount > 0 && host.contains(sel.anchorNode);
    if (sel && (${clear ? 'true' : 'false'} || !inside)) {
      const range = document.createRange();
      range.selectNodeContents(host);
      if (!${clear ? 'true' : 'false'}) range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    ${marker ? `host.setAttribute('data-bx-type', ${JSON.stringify(marker)});` : ''}
    return JSON.stringify({ trusted: true, hadContent: (host.innerText || '').trim().length > 0 });
  }
  if (${submit ? 'true' : 'false'}) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    const form = el.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
  }
  return JSON.stringify({ ok: true });
})()`
}

/**
 * Finds the file input for browser_upload_file: the target itself, or an
 * input[type=file] inside it (sites often hide the real input). Tags it with
 * a one-off attribute so CDP can resolve the same node.
 */
export function buildUploadTargetScript(refOrSelector: string, marker: string): string {
  return `(() => {
  ${selectorGuard(refOrSelector)}
  const target = ${JSON.stringify(refOrSelector)};
  let el = document.querySelector(${queryFor(refOrSelector)});
  if (!el) return JSON.stringify({ error: 'Stale or unknown target ' + JSON.stringify(target) + ' — run browser_snapshot again or pass a CSS selector such as input[type=file].' });
  if (!(el.tagName === 'INPUT' && el.type === 'file')) el = el.querySelector('input[type=file]') || (el.tagName === 'LABEL' && el.control) || el;
  if (!(el.tagName === 'INPUT' && el.type === 'file')) return JSON.stringify({ error: 'Target ' + JSON.stringify(target) + ' is not an <input type=file> and does not contain one.' });
  el.setAttribute('data-bx-upload', ${JSON.stringify(marker)});
  return JSON.stringify({ ok: true, multiple: !!el.multiple, disabled: !!el.disabled });
})()`
}

/** Scrolls the page or, when given a target, that element into view. */
export function buildScrollScript(direction?: string, amount?: number, refOrSelector?: string): string {
  const delta = typeof amount === 'number' && amount > 0 ? Math.round(amount) : 600
  if (refOrSelector) {
    return `(() => {
  ${selectorGuard(refOrSelector)}
  const el = document.querySelector(${queryFor(refOrSelector)});
  if (!el) return JSON.stringify({ error: 'Stale or unknown target — run browser_snapshot again.' });
  el.scrollIntoView({ block: 'center' });
  return JSON.stringify({ ok: true });
})()`
  }
  const dy = direction?.toLowerCase() === 'up' ? -delta : direction?.toLowerCase() === 'left' ? -delta : direction?.toLowerCase() === 'right' ? delta : delta
  const dx = direction?.toLowerCase() === 'left' || direction?.toLowerCase() === 'right' ? dy : 0
  const scrollY = dx === 0 ? dy : 0
  return `(() => { window.scrollBy(0, ${scrollY}); return JSON.stringify({ ok: true, scrollY: window.scrollY }); })()`
}

/** Reads page-level facts: url, title or full text content. */
export function buildGetScript(what: string): string {
  switch (what) {
    case 'url':
      return `(() => JSON.stringify({ url: location.href }))()`
    case 'title':
      return `(() => JSON.stringify({ title: document.title }))()`
    case 'text':
      return `(() => JSON.stringify({ text: (document.body?.innerText || '').slice(0, 20000) }))()`
    default:
      return `JSON.stringify({ error: 'what must be "url", "title" or "text"' })`
  }
}

/** Waits until a selector appears, text shows up, or the URL changes. */
export function buildWaitScript(mode: 'selector' | 'text' | 'url', value: string, timeoutMs: number): string {
  const t = Math.max(500, Math.min(timeoutMs || 10000, 60000))
  return `(async () => {
  ${mode === 'selector' ? selectorGuard(value) : ''}
  const t0 = Date.now();
  for (;;) {
    let hit = false;
    ${
      mode === 'selector'
        ? `hit = !!document.querySelector(${JSON.stringify(value)});`
        : mode === 'text'
          ? `hit = (document.body?.innerText || '').includes(${JSON.stringify(value)});`
          : `hit = location.href.includes(${JSON.stringify(value)});`
    }
    if (hit) return JSON.stringify({ ok: true, waitedMs: Date.now() - t0 });
    if (Date.now() - t0 >= ${t}) return JSON.stringify({ error: 'Timed out after ${t}ms waiting for ${mode}: ' + ${JSON.stringify(value)} });
    await new Promise(r => setTimeout(r, 250));
  }
})()`
}

/** A single captured browser console message for one panel. */
export interface ConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source: string
  line: number
  /** Epoch millis when the main process observed the message. */
  at: number
}

/** Ring-buffer cap per panel — bounds memory when pages log in loops. */
export const CONSOLE_BUFFER_CAP = 200

const CONSOLE_LEVELS = ['debug', 'info', 'warning', 'error'] as const

/** Maps Electron's console-message numeric level to a stable name. */
export function consoleLevelName(level: number): ConsoleEntry['level'] {
  return CONSOLE_LEVELS[level] ?? (level >= 3 ? 'error' : 'debug')
}

/** Pushes an entry, evicting the oldest when the buffer is full. */
export function pushConsoleEntry(buffer: ConsoleEntry[], entry: ConsoleEntry, cap = CONSOLE_BUFFER_CAP): ConsoleEntry[] {
  buffer.push(entry)
  while (buffer.length > cap) buffer.shift()
  return buffer
}

export interface ConsoleFilter {
  level?: string
  /** Max entries to return (newest last). Defaults to 100, clamped to the buffer cap. */
  limit?: number
}

/** Applies level filter + limit; returns entries oldest-first. */
export function filterConsoleEntries(entries: ConsoleEntry[], filter: ConsoleFilter = {}): ConsoleEntry[] {
  const level = (filter.level || '').toLowerCase()
  const scoped = level ? entries.filter((e) => e.level === level) : entries.slice()
  const limit = Math.max(1, Math.min(filter.limit ?? 100, CONSOLE_BUFFER_CAP))
  return scoped.slice(-limit)
}

/** A single performance-timeline entry behind browser_network. */
export interface NetworkEntry {
  url: string
  initiator: string
  durationMs: number
  transferSize: number
  decodedSize: number
  /** HTTP status when Chromium exposes it (0 when unknown / failed). */
  status: number
}

export interface ResourceTimingResult {
  navigation: NetworkEntry[]
  resources: NetworkEntry[]
}

/** Max resource rows a single browser_network call returns. */
export const NETWORK_RESULT_CAP = 200

/**
 * Builds the injected script behind browser_network: reads the page's
 * performance timeline (navigation + resource entries) — the same data
 * agent-browser surfaces via `network requests`, but panel-scoped through
 * executeJavaScript so no debugger attachment or CDP socket is needed.
 */
export function buildResourceTimingScript(filter?: string, limit?: number): string {
  const lim = Math.max(1, Math.min(limit ?? 50, NETWORK_RESULT_CAP))
  return `(() => {
  const pick = (e) => ({
    url: String(e.name || '').slice(0, 500),
    initiator: String(e.initiatorType || e.entryType || ''),
    durationMs: Math.round(e.duration || 0),
    transferSize: e.transferSize || 0,
    decodedSize: e.decodedBodySize || 0,
    status: e.responseStatus || 0
  });
  const match = (u) => !${JSON.stringify(filter || '')} || u.includes(${JSON.stringify(filter || '')});
  let nav = [];
  let res = [];
  try {
    nav = performance.getEntriesByType('navigation').map(pick).filter((e) => match(e.url));
    res = performance.getEntriesByType('resource').map(pick).filter((e) => match(e.url)).slice(-${lim});
  } catch (err) {
    return JSON.stringify({ error: 'Resource timing unavailable: ' + (err && err.message ? err.message : String(err)) });
  }
  return JSON.stringify({ navigation: nav, resources: res });
})()`
}

/** Parses the payload returned by buildResourceTimingScript(). */
export function parseResourceTimingResult(raw: unknown): ResourceTimingResult | { error: string } {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { error: 'Malformed network payload' }
    }
  }
  const result = parsed as ResourceTimingResult | null
  if (!result || typeof result !== 'object' || !Array.isArray(result.resources) || !Array.isArray(result.navigation)) {
    return { error: 'Malformed network payload' }
  }
  return result
}

/** Parses whatever executeJavaScript resolved into a plain object. */
export function unwrapEval(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      return { ok: true, value: raw }
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  return { ok: true }
}

/**
 * Guarantees a command settles even when the page cannot answer — e.g. an
 * in-page polling loop starved by background timer throttling, or a renderer
 * busy in a modal loop. Without this a tool call could hang forever.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(ms, 0))
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ── Broker ───────────────────────────────────────────────────────────────────

const PAGE_TIMEOUT_ERROR = 'Timed out after 30s — the page did not answer (it may be navigating or throttled in the background).'

export class PanelBrowserBroker {
  private registry: PanelRegistry = new Map()
  /** In-process CDP sessions for uploads / screenshots only (never Input.*). */
  private debuggerSessions = new PanelDebuggerSessions()
  private recordingService?: BrowserRecordingService
  private recordingNonces = new Map<string, string>()
  private recordingQueues = new Map<string, Promise<void>>()
  private recordingFlushWaiters = new Map<string, () => void>()
  private recordingHooks = new Set<number>()
  get recordings(): BrowserRecordingService {
    return this.recordingService ??= new BrowserRecordingService(join(app.getPath('userData'), 'browser-recordings'))
  }
  recordingStatus(panelId: string): { recording: ReturnType<BrowserRecordingService['status']> } {
    return { recording: this.recordings.status(panelId) ?? this.recordings.last(panelId) }
  }
  async startRecording(panelId: string, title?: string): Promise<BrowserRecordingResult> {
    const panel = this.registry.get(panelId)
    const wc = panel && this.getLiveWebContents(panel.webContentsId)
    if (!panel || !wc) return { error: 'Browser panel is not available' }
    try {
      const recording = this.recordings.start(panelId, [...panel.taskIds], title)
      this.recordingNonces.set(panelId, randomUUID())
      this.ensureConsoleHook(panel.webContentsId, wc)
      this.ensureRecordingHooks(wc)
      await this.installRecorder(panelId, wc)
      await this.recordStep(wc, { source: 'browser', action: 'recording-start', snapshotPhase: 'initial' })
      return { ok: true, recording }
    } catch { return { error: 'Could not start browser recording' } }
  }
  async stopRecording(panelId: string): Promise<BrowserRecordingResult> {
    const panel = this.registry.get(panelId)
    if (!panel || !this.recordingService?.status(panelId)) return { error: 'This browser is not recording' }
    const wc = this.getLiveWebContents(panel.webContentsId)
    try {
      if (wc) {
        let acknowledgeFlush: (() => void) | undefined
        const flushQueued = new Promise<void>((resolve) => { acknowledgeFlush = resolve })
        this.recordingFlushWaiters.set(panelId, acknowledgeFlush!)
        const removed = await withTimeout(wc.executeJavaScriptInIsolatedWorld(RECORDING_WORLD, [{ code: RECORDING_REMOVE_SCRIPT }]).catch(() => false), 2000, false)
        const flushConfirmed = removed ? await withTimeout(flushQueued.then(() => true), 1000, false) : false
        if (!flushConfirmed) this.recordings.gap(panelId, 'Pending input flush could not be confirmed before Stop.')
        this.recordingFlushWaiters.delete(panelId)
      } else this.recordings.gap(panelId, 'The final snapshot was unavailable because the browser was closed.')
      await this.recordingQueues.get(panelId)
      if (wc) await this.recordStep(wc, { source: 'browser', action: 'recording-stop', snapshotPhase: 'final' })
      await this.recordingQueues.get(panelId)
      this.recordingNonces.delete(panelId)
      return { ok: true, recording: this.recordings.stop(panelId, [...panel.taskIds]) }
    } catch {
      this.recordingFlushWaiters.delete(panelId)
      return { error: 'Could not save browser recording' }
    }
  }
  private async installRecorder(panelId: string, wc: Electron.WebContents): Promise<void> {
    const nonce = this.recordingNonces.get(panelId)
    if (!nonce) return
    try {
      const result = await withTimeout(wc.executeJavaScriptInIsolatedWorld(RECORDING_WORLD, [{ code: buildRecordingInstallScript(nonce) }]), 2000, false)
      if (!result) this.recordings.gap(panelId, 'Document event capture could not start.')
    } catch { this.recordings.gap(panelId, 'Document event capture could not start.') }
  }
  private ensureRecordingHooks(wc: Electron.WebContents): void {
    if (this.recordingHooks.has(wc.id)) return
    this.recordingHooks.add(wc.id)
    wc.on('dom-ready', () => {
      for (const [id, p] of this.registry) if (p.webContentsId === wc.id && this.recordingNonces.has(id)) {
        this.recordings.gap(id, 'Events between navigation and document readiness are not captured.')
        void this.installRecorder(id, wc)
      }
      void this.recordStep(wc, { source: 'browser', action: 'document-ready', snapshotPhase: 'document-ready' })
    })
    wc.on('did-navigate-in-page', () => { void this.recordStep(wc, { source: 'browser', action: 'navigation', snapshotPhase: 'after-action' }) })
    wc.on('did-fail-load', () => { void this.recordStep(wc, { source: 'browser', action: 'navigation-failed', outcome: 'error', snapshotPhase: 'after-action' }) })
    wc.on('destroyed', () => {
      this.recordingHooks.delete(wc.id)
      for (const [id, p] of this.registry) if (p.webContentsId === wc.id) this.interruptRecording(id)
    })
  }
  private interruptRecording(panelId: string, message = 'Browser closed before Stop. Pending snapshots may be missing.', wc?: Electron.WebContents): void {
    this.recordingNonces.delete(panelId)
    this.recordingFlushWaiters.delete(panelId)
    const panel = this.registry.get(panelId)
    if (this.recordingService?.status(panelId)) {
      this.recordingService.interrupt(panelId, panel ? [...panel.taskIds] : [], message)
    }
    if (wc && !wc.isDestroyed()) void withTimeout(wc.executeJavaScriptInIsolatedWorld(RECORDING_WORLD, [{ code: RECORDING_REMOVE_SCRIPT }]).catch(() => undefined), 2000, undefined)
  }
  private recordStep(wc: Electron.WebContents, step: Omit<BrowserRecordingStep, 'sequence' | 'at' | 'snapshotId'>): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const [id, panel] of this.registry) {
      if (panel.webContentsId !== wc.id || !this.recordingNonces.has(id)) continue
      const recordingId = this.recordingService?.status(id)?.id
      const pending = (this.recordingQueues.get(id) ?? Promise.resolve()).then(async () => {
        let snapshot: Omit<BrowserRecordingSnapshot, 'id'> | null = null
        let snapshotGap: string | undefined
        try {
          snapshot = await withTimeout(wc.executeJavaScriptInIsolatedWorld(RECORDING_WORLD, [{ code: buildRecordingSnapshotScript() }]), 2000, null)
          if (!snapshot) snapshotGap = 'One or more snapshots timed out.'
        } catch { snapshotGap = 'One or more snapshots were unavailable.' }
        if (this.recordingService?.status(id)?.id !== recordingId) return
        try {
          this.recordings.append(id, { ...step, url: wc.getURL() }, snapshot || undefined)
          if (snapshotGap && this.recordingService?.status(id)) this.recordings.gap(id, snapshotGap)
        } catch {
          this.interruptRecording(id, 'Recording stopped because capture data could not be written.', wc)
        }
      }).catch(() => { this.interruptRecording(id, 'Recording stopped because capture data could not be written.', wc) })
      this.recordingQueues.set(id, pending)
      jobs.push(pending)
    }
    return Promise.all(jobs).then(() => undefined)
  }
  private receiveRecordingMessage(webContentsId: number, message: string): boolean {
    if (!message.startsWith(RECORDING_PREFIX)) return false
    for (const [id, panel] of this.registry) {
      const nonce = this.recordingNonces.get(id)
      if (panel.webContentsId !== webContentsId || !nonce || !message.startsWith(RECORDING_PREFIX + nonce + ':')) continue
      try {
        if (message.length > 50000) throw new Error('too large')
        const payload = JSON.parse(message.slice((RECORDING_PREFIX + nonce + ':').length))
        if (payload.action === 'recording-flush-complete') {
          this.recordingFlushWaiters.get(id)?.()
          continue
        }
        if (!(typeof payload.action === 'string' && /^(click|input|change|submit|scroll|keydown:(Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight))$/.test(payload.action)) || !Array.isArray(payload.snapshot?.elements)) throw new Error('invalid event')
        const snapshot: Omit<BrowserRecordingSnapshot, 'id'> = {
          url: String(payload.snapshot.url || ''), text: String(payload.snapshot.text || '').slice(0, 4000), truncated: !!payload.snapshot.truncated,
          elements: payload.snapshot.elements.slice(0, 120).map((e: Record<string, unknown>) => ({ tag: String(e.tag || '').slice(0, 30), role: String(e.role || '').slice(0, 30), name: String(e.name || '').slice(0, 120), index: typeof e.index === 'number' && Number.isInteger(e.index) && e.index > 0 ? e.index : undefined, locator: typeof e.locator === 'string' ? e.locator.slice(0, 160) : undefined, inputType: typeof e.inputType === 'string' ? e.inputType.slice(0, 30) : undefined, value: typeof e.value === 'string' ? e.value.slice(0, 120) : undefined, checked: typeof e.checked === 'boolean' ? e.checked : undefined }))
        }
        const recordingId = this.recordingService?.status(id)?.id
        const pending = (this.recordingQueues.get(id) ?? Promise.resolve()).then(() => {
          if (this.recordingService?.status(id)?.id !== recordingId) return
          try {
            this.recordings.append(id, { source: 'human', action: payload.action, target: String(payload.target || '').slice(0, 300), url: snapshot.url, snapshotPhase: 'before-action' }, snapshot)
          } catch {
            this.interruptRecording(id, 'Recording stopped because capture data could not be written.', this.getLiveWebContents(webContentsId) ?? undefined)
          }
        }).catch(() => { this.interruptRecording(id, 'Recording stopped because capture data could not be written.', this.getLiveWebContents(webContentsId) ?? undefined) })
        this.recordingQueues.set(id, pending)
      } catch {
        try { this.recordingService?.gap(id, 'One or more page events could not be saved.') } catch {
          this.interruptRecording(id, 'Recording stopped because capture data could not be written.', this.getLiveWebContents(webContentsId) ?? undefined)
        }
      }
    }
    return true
  }
  /**
   * Per-panel console ring buffers. Filled from the main-process
   * `console-message` event — page JS history cannot be re-read after the
   * fact, so buffering at observe time is the only way to expose past logs
   * without a debugger attachment.
   */
  private consoleBuffers: Map<string, ConsoleEntry[]> = new Map()
  /** webContentsIds already carrying a console-message listener. */
  private consoleHooked: Set<number> = new Set()

  registerPanel(panelId: string, webContentsId: number, taskIds: string[]): boolean {
    const wc = this.getLiveWebContents(webContentsId)
    if (!wc) return false
    this.registry.set(panelId, { webContentsId, taskIds: new Set(taskIds) })
    // Agent-driven panels usually sit behind other panels or off-viewport.
    // A throttled/hidden renderer starves page-side polling (browser_wait),
    // delays executeJavaScript and makes capturePage fail, so keep it live.
    try {
      wc.setBackgroundThrottling?.(false)
    } catch {
      // Best effort — torn-down contents.
    }
    if (!this.consoleBuffers.has(panelId)) this.consoleBuffers.set(panelId, [])
    this.ensureConsoleHook(webContentsId, wc)
    return true
  }

  /** Replaces just the task linkage (edges changed), keeping the webContentsId. */
  setPanelTasks(panelId: string, taskIds: string[]): boolean {
    const panel = this.registry.get(panelId)
    if (!panel) return false
    panel.taskIds = new Set(taskIds)
    return true
  }

  unregisterPanel(panelId: string): boolean {
    this.interruptRecording(panelId)
    this.consoleBuffers.delete(panelId)
    const entry = this.registry.get(panelId)
    const removed = this.registry.delete(panelId)
    if (entry && ![...this.registry.values()].some((p) => p.webContentsId === entry.webContentsId)) {
      this.debuggerSessions.release(entry.webContentsId)
    }
    return removed
  }

  listPanels(taskId: string): Array<{ panelId: string; url: string; title: string }> {
    const out: Array<{ panelId: string; url: string; title: string }> = []
    for (const [panelId, entry] of this.registry) {
      if (!entry.taskIds.has(taskId)) continue
      const wc = this.getLiveWebContents(entry.webContentsId)
      out.push({
        panelId,
        url: wc ? wc.getURL() : '',
        title: wc ? wc.getTitle() : ''
      })
    }
    return out
  }

  stopAll(): void {
    for (const id of this.registry.keys()) this.interruptRecording(id)
    for (const panel of this.registry.values()) this.debuggerSessions.release(panel.webContentsId)
    this.registry.clear()
    this.consoleBuffers.clear()
    this.consoleHooked.clear()
  }

  private getLiveWebContents(webContentsId: number): Electron.WebContents | null {
    if (typeof webContentsId !== 'number') return null
    try {
      const wc = webContents.fromId(webContentsId)
      return wc && !wc.isDestroyed() && wc.session === getAgentBrowserSession() ? wc : null
    } catch {
      return null
    }
  }

  /** Resolves the live webContents for a task-scoped command, or an error object. */
  private resolve(taskId: string, panelId?: string | null):
    | { ok: true; wc: Electron.WebContents }
    | { ok: false; error: string } {
    const resolved = resolvePanelForTask(this.registry, taskId, panelId)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const entry = this.registry.get(resolved.panelId)!
    const wc = this.getLiveWebContents(entry.webContentsId)
    if (!wc) {
      this.registry.delete(resolved.panelId)
      return { ok: false, error: 'That browser panel was closed. Use browser_list_panels.' }
    }
    // Late-attach: the panel may have registered before its webContents
    // existed (first dom-ready had not fired yet).
    this.ensureConsoleHook(entry.webContentsId, wc)
    return { ok: true, wc }
  }

  /**
   * Attaches a single `console-message` listener per live webContents. The
   * fan-out is by webContentsId so one listener serves every panel sharing
   * it, and the main app window is never hooked (it never appears here —
   * only explicitly registered panels do).
   */
  private ensureConsoleHook(webContentsId: number, wc: Electron.WebContents): void {
    if (this.consoleHooked.has(webContentsId)) return
    if (typeof (wc as { on?: unknown }).on !== 'function') return
    try {
      wc.on('console-message', (_event, level, message, line, sourceId) => {
        const details = _event as unknown as { message?: string }
        if (this.receiveRecordingMessage(webContentsId, String(details.message ?? message ?? ''))) return
        const entry: ConsoleEntry = {
          level: consoleLevelName(typeof level === 'number' ? level : 0),
          message: String(message ?? '').slice(0, 2000),
          source: String(sourceId ?? '').slice(0, 300),
          line: typeof line === 'number' ? line : 0,
          at: Date.now()
        }
        for (const [id, panel] of this.registry) {
          if (panel.webContentsId !== webContentsId) continue
          const buffer = this.consoleBuffers.get(id) ?? []
          pushConsoleEntry(buffer, entry)
          this.consoleBuffers.set(id, buffer)
        }
      })
      this.consoleHooked.add(webContentsId)
    } catch {
      // Listener attachment is best-effort (e.g. torn-down contents).
    }
  }

  private async eval(wc: Electron.WebContents, script: string): Promise<Record<string, unknown>> {
    try {
      return unwrapEval(await wc.executeJavaScript(script, true))
    } catch (err) {
      return { error: evalErrorMessage(err) }
    }
  }

  async navigate(taskId: string, url: string, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    let target = (url || '').trim()
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target
    await this.recordStep(resolved.wc, { source: 'agent', action: 'navigate', outcome: 'pending', snapshotPhase: 'before-action' })
    try {
      await resolved.wc.loadURL(target)
      return { ok: true, url: resolved.wc.getURL(), title: resolved.wc.getTitle() }
    } catch (err) {
      // loadURL rejects on did-fail-load (e.g. ERR_ABORTED on client redirects)
      // but the page may still have navigated — report where it actually landed.
      const current = resolved.wc.getURL()
      if (current && current !== 'about:blank' && !resolved.wc.isLoading()) {
        return { ok: true, url: current, title: resolved.wc.getTitle(), note: (err as Error).message }
      }
      return { error: `Navigation failed: ${(err as Error).message}` }
    }
  }

  private historyStep(taskId: string, fn: (wc: Electron.WebContents) => void, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return Promise.resolve(resolved)
    return new Promise((resolve) => {
      const wc = resolved.wc
      const done = (): void => {
        cleanup()
        resolve({ ok: true, url: wc.getURL() })
      }
      const timer = setTimeout(done, 15000)
      const cleanup = (): void => {
        clearTimeout(timer)
        wc.removeListener('did-stop-loading', done)
        wc.removeListener('did-navigate', done)
      }
      wc.once('did-stop-loading', done)
      wc.once('did-navigate', done)
      void this.recordStep(wc, { source: 'agent', action: 'history-or-reload', outcome: 'pending', snapshotPhase: 'before-action' })
      fn(wc)
    })
  }

  back(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.historyStep(taskId, (wc) => wc.goBack(), panelId)
  }

  forward(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.historyStep(taskId, (wc) => wc.goForward(), panelId)
  }

  reload(taskId: string, panelId?: string | null, hard = false): Promise<Record<string, unknown>> {
    return this.historyStep(taskId, (wc) => (hard ? wc.reloadIgnoringCache() : wc.reload()), panelId)
  }

  async snapshot(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    const evalResult = await this.eval(resolved.wc, buildSnapshotScript())
    if (evalResult.error) return evalResult
    const result = parseSnapshotResult(evalResult)
    if ('error' in result) return result
    return result as unknown as Record<string, unknown>
  }

  click(taskId: string, target: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.recordAction(taskId, panelId, 'click', buildClickScript(target), target)
  }

  /**
   * Types into an input/textarea/select (value setter) or a contenteditable
   * rich-text editor (trusted input via the guest webContents: insertText per line and a real
   * Enter key between lines, so block editors create new paragraphs).
   * clear=false keeps existing content and types at the caret / the end.
   */
  type(taskId: string, target: string, text: string, submit?: boolean, panelId?: string | null, clear = true): Promise<Record<string, unknown>> {
    return this.recordActionWith(taskId, panelId, submit ? 'type-and-submit' : 'type', async (wc) => {
      const marker = randomUUID()
      const prepared = await this.eval(wc, buildTypeScript(target, text, submit, clear, marker))
      if (prepared.trusted !== true) return prepared
      try {
        // Let the editor observe the new selection (selectionchange is async).
        await new Promise((r) => setTimeout(r, 50))
        return await typeIntoEditor(wc as unknown as GuestInputWebContents, (script) => this.eval(wc, script), {
          marker,
          text,
          clearFirst: clear && prepared.hadContent === true,
          submit: submit === true
        })
      } finally {
        await this.eval(wc, buildEditorCleanupScript(marker))
      }
    }, target)
  }

  /**
   * Presses a key or combo ("Enter", "Backspace", "a", "Control+B",
   * "Meta+B", "Shift+Enter") on the focused element with trusted input.
   */
  pressKey(taskId: string, key: string, panelId?: string | null): Promise<Record<string, unknown>> {
    const parsed = parseKeyCombo(key)
    if ('error' in parsed) return Promise.resolve({ error: parsed.error })
    const label = parsed.text && !parsed.modifiers ? 'press-key (character omitted)' : `press-key:${key}`
    return this.recordActionWith(taskId, panelId, label, (wc) =>
      pressKeyInGuest(wc as unknown as GuestInputWebContents, (script) => this.eval(wc, script), parsed))
  }

  /**
   * Sets files on an <input type=file> (target itself or one inside it) via
   * CDP DOM.setFileInputFiles, which fires trusted input/change events.
   * `files` must already be validated absolute paths (resolveUploadPaths).
   */
  uploadFile(taskId: string, target: string, files: string[], panelId?: string | null): Promise<Record<string, unknown>> {
    return this.recordActionWith(taskId, panelId, `upload-file:${files.length}`, async (wc) => {
      const marker = randomUUID()
      const found = await this.eval(wc, buildUploadTargetScript(target, marker))
      if (found.error) return found
      if (found.disabled === true) return { error: 'The file input is disabled.' }
      if (files.length > 1 && found.multiple !== true) return { error: 'This file input accepts a single file; pass one path.' }
      const session = this.debuggerSessions.acquire(wc as unknown as InputWebContents)
      if (!('send' in session)) return { error: `${session.error}. File upload needs the panel debugger; close DevTools on this panel and retry.` }
      try {
        const doc = await session.send('DOM.getDocument', { depth: 0 }) as { root?: { nodeId?: number } }
        const rootId = doc?.root?.nodeId
        if (typeof rootId !== 'number') return { error: 'Could not read the page document.' }
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: rootId, selector: `[data-bx-upload="${marker}"]` }) as { nodeId?: number }
        if (!nodeId) return { error: 'The file input disappeared before upload.' }
        await session.send('DOM.setFileInputFiles', { files, nodeId })
        return { ok: true, files: files.length }
      } catch (err) {
        return { error: `Upload failed: ${(err as Error).message}` }
      } finally {
        await this.eval(wc, `(() => { for (const el of document.querySelectorAll(${JSON.stringify(`[data-bx-upload="${marker}"]`)})) el.removeAttribute('data-bx-upload'); return JSON.stringify({ ok: true }); })()`)
      }
    }, target)
  }

  scroll(taskId: string, direction?: string, amount?: number, target?: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.recordAction(taskId, panelId, `scroll:${['up','down','left','right'].includes(direction || '') ? direction : 'down'}:${Math.max(0, Math.min(amount || 600, 100000))}`, buildScrollScript(direction, amount, target), target)
  }

  get(taskId: string, what: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.evalOnResolved(taskId, panelId, buildGetScript(what))
  }

  /**
   * Returns buffered console messages for a panel (agent-browser parity for
   * `console` / `errors`). Capture starts with the first command against the
   * panel; messages before that are not available. Pass clear=true to drain
   * the buffer after reading (e.g. polling for new errors in a loop).
   */
  async console(
    taskId: string,
    filter: ConsoleFilter & { clear?: boolean } = {},
    panelId?: string | null
  ): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    const resolvedPanel = resolvePanelForTask(this.registry, taskId, panelId)
    if (!resolvedPanel.ok) return { error: resolvedPanel.error }
    const buffer = this.consoleBuffers.get(resolvedPanel.panelId) ?? []
    const entries = filterConsoleEntries(buffer, filter)
    if (filter.clear) this.consoleBuffers.set(resolvedPanel.panelId, [])
    return { entries, count: entries.length, buffered: buffer.length } as unknown as Record<string, unknown>
  }

  /**
   * Returns recent network activity for a panel from the page performance
   * timeline (agent-browser parity for `network requests`): document
   * navigations plus subresource / fetch / XHR rows with URL, initiator,
   * timing and sizes. No request/response headers or bodies — those need a
   * session webRequest tap (documented follow-up), deliberately out of scope
   * here to avoid touching the shared-session handlers.
   */
  async network(taskId: string, filter?: string, limit?: number, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    const evalResult = await this.evalOnResolved(taskId, panelId, buildResourceTimingScript(filter, limit))
    if (evalResult.error) return evalResult
    const result = parseResourceTimingResult(evalResult)
    if ('error' in result) return result
    return result as unknown as Record<string, unknown>
  }

  async wait(taskId: string, mode: 'selector' | 'text' | 'url', value: string, timeoutMs?: number, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    const budget = Math.max(500, Math.min(timeoutMs ?? 10000, 60000))
    if (mode === 'url') {
      // Poll from the Node side: background/hidden panels throttle in-page
      // timers, so a page-side polling loop can miss its own deadline.
      const started = Date.now()
      const deadline = started + budget
      for (;;) {
        const url = resolved.wc.getURL()
        if (url.includes(value)) return { ok: true, waitedMs: Date.now() - started, url }
        if (Date.now() >= deadline) {
          return { error: `Timed out after ${budget}ms waiting for url: ${value}`, url }
        }
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    return withTimeout(
      this.evalOnResolved(taskId, panelId, buildWaitScript(mode, value, budget)),
      budget + 5000,
      { error: `Timed out after ${budget + 5000}ms waiting for ${mode}: ${value}` }
    )
  }

  private recordAction(taskId: string, panelId: string | null | undefined, action: string, script: string, target?: string): Promise<Record<string, unknown>> {
    return this.recordActionWith(taskId, panelId, action, (wc) => this.eval(wc, script), target)
  }

  private async recordActionWith(
    taskId: string,
    panelId: string | null | undefined,
    action: string,
    run: (wc: Electron.WebContents) => Promise<Record<string, unknown>>,
    target?: string
  ): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    let description: string | undefined
    if (target && [...this.registry].some(([id, p]) => p.webContentsId === resolved.wc.id && this.recordingNonces.has(id))) {
      const selector = /^@?e\d+$/.test(target) ? `[data-bx-ref="${normalizeRef(target)}"]` : target
      description = await withTimeout(resolved.wc.executeJavaScriptInIsolatedWorld(RECORDING_WORLD, [{ code: buildRecordingTargetScript(selector) }]).catch(() => '[unknown target]'), 2000, '[unknown target]')
    }
    const result = await withTimeout(run(resolved.wc), 30000, { error: PAGE_TIMEOUT_ERROR })
    const commandTarget = target ? sanitizeRecordingTarget(target) : undefined
    const recordedTarget = commandTarget ? `${/^@?e\d+$/.test(commandTarget) ? 'ref' : 'selector'} ${commandTarget}${description ? ` | ${description}` : ''}`.slice(0, 300) : description
    await this.recordStep(resolved.wc, { source: 'agent', action, target: recordedTarget, outcome: result.error ? 'error' : 'ok', snapshotPhase: 'after-action' })
    return result
  }

  private async evalOnResolved(taskId: string, panelId: string | null | undefined, script: string): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    return withTimeout(this.eval(resolved.wc, script), 30000, { error: PAGE_TIMEOUT_ERROR })
  }

  /**
   * Captures the panel. capturePage() needs a presented compositor frame and
   * can fail ("UnknownVizError") or hang for a panel that is hidden /
   * off-viewport; then fall back to CDP Page.captureScreenshot, which renders
   * a fresh frame for the page itself.
   */
  async screenshot(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    const wc = resolved.wc
    let png: Buffer | null = null
    let firstError = ''
    try {
      const image = await withTimeout(wc.capturePage(), 10000, null)
      if (image && !image.isEmpty()) png = image.toPNG()
      else firstError = image ? 'empty image' : 'timed out'
    } catch (err) {
      firstError = (err as Error).message
    }
    if (!png) {
      const session = this.debuggerSessions.acquire(wc as unknown as InputWebContents)
      if ('send' in session) {
        try {
          const shot = await withTimeout(captureViaCdp(session.send), 15000, null)
          if (shot) png = shot
        } catch (err) {
          firstError = `${firstError}; CDP: ${(err as Error).message}`
        }
      }
    }
    if (!png) return { error: `Screenshot failed: ${firstError || 'no image'}. Bring the panel into view on the canvas and retry.` }
    try {
      const dir = join(app.getPath('temp'), '20x-browser-screenshots')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${taskId}-${Date.now()}.png`)
      writeFileSync(file, png)
      return { ok: true, path: file }
    } catch (err) {
      return { error: `Screenshot failed: ${(err as Error).message}` }
    }
  }
}

async function captureViaCdp(send: CdpSend): Promise<Buffer | null> {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as { data?: string }
  return typeof result?.data === 'string' && result.data ? Buffer.from(result.data, 'base64') : null
}

export const panelBrowserBroker = new PanelBrowserBroker()
