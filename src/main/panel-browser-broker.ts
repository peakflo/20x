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
 * Everything runs on plain Electron APIs (loadURL / executeJavaScript /
 * capturePage) — no debugger attachment, no CDP sockets.
 */
import { app, webContents } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

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

const SNAPSHOT_ELEMENT_CAP = 120

/**
 * Builds the injected script behind browser_snapshot: labels every visible
 * interactive element with data-bx-ref="eN" and returns a compact JSON line
 * per element — the same @ref ergonomics agents know from agent-browser.
 */
export function buildSnapshotScript(): string {
  return `(() => {
  const SEL = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=switch],[onclick],[contenteditable=true],summary';
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
      value: ['INPUT','SELECT','TEXTAREA'].includes(el.tagName) ? String(el.value ?? '').slice(0, 60) : undefined,
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

/** Parses the stringified-JSON payload returned by buildSnapshotScript(). */
export function parseSnapshotResult(raw: unknown): SnapshotResult | { error: string } {
  if (typeof raw !== 'string') return { error: 'Unexpected snapshot result shape' }
  try {
    const parsed = JSON.parse(raw) as SnapshotResult
    if (!parsed || !Array.isArray(parsed.elements)) return { error: 'Malformed snapshot payload' }
    return parsed
  } catch {
    return { error: 'Malformed snapshot payload' }
  }
}

function queryFor(refOrSelector: string): string {
  const looksLikeRef = /^@?e\d+$/.test(refOrSelector.trim())
  if (!looksLikeRef) {
    // Treat anything else as a CSS selector.
    return JSON.stringify(refOrSelector)
  }
  return JSON.stringify(`[data-bx-ref="${normalizeRef(refOrSelector.trim())}"]`)
}

/** Clicks a snapshot ref (or CSS selector), scrolling it into view first. */
export function buildClickScript(refOrSelector: string): string {
  return `(async () => {
  const el = document.querySelector(${queryFor(refOrSelector)});
  if (!el) return JSON.stringify({ error: 'Stale or unknown target "${refOrSelector.replace(/"/g, '')}" — run browser_snapshot again.' });
  el.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 50));
  el.click();
  return JSON.stringify({ ok: true });
})()`
}

/** Focuses an element and sets its value with React-compatible events. */
export function buildTypeScript(refOrSelector: string, text: string, submit?: boolean): string {
  return `(async () => {
  const el = document.querySelector(${queryFor(refOrSelector)});
  if (!el) return JSON.stringify({ error: 'Stale or unknown target — run browser_snapshot again.' });
  el.focus();
  if (el.tagName === 'SELECT') {
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, ${JSON.stringify(text)});
    else el.textContent = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
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

const KEY_CODES: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
}

/** Maps user-facing key names ("Enter", "arrowdown") to CDP-style key data. */
export function resolveKeyName(key: string): { key: string; code: string; keyCode: number } | null {
  const k = KEY_CODES[key.toLowerCase()]
  if (k) return k
  if (/^[a-z0-9]$/i.test(key)) {
    return { key: key.toUpperCase(), code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) }
  }
  return null
}

/** Dispatches a keydown/keypress/keyup sequence on the focused element. */
export function buildPressScript(key: string): string {
  const k = resolveKeyName(key)
  if (!k) return `JSON.stringify({ error: 'Unsupported key ${JSON.stringify(key)} — use Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown or a single character.' })`
  const init = JSON.stringify(k)
  return `(() => {
  const target = document.activeElement || document.body;
  const opts = { ...${init}, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  return JSON.stringify({ ok: true });
})()`
}

/** Scrolls the page or, when given a target, that element into view. */
export function buildScrollScript(direction?: string, amount?: number, refOrSelector?: string): string {
  const delta = typeof amount === 'number' && amount > 0 ? Math.round(amount) : 600
  if (refOrSelector) {
    return `(() => {
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
    if (Date.now() - t0 >= ${t}) return JSON.stringify({ error: 'Timed out after ${t}ms waiting for ${mode}: ${value.replace(/[\\"]|<\/script/g, '')}' });
    await new Promise(r => setTimeout(r, 250));
  }
})()`
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

// ── Broker ───────────────────────────────────────────────────────────────────

export class PanelBrowserBroker {
  private registry: PanelRegistry = new Map()

  registerPanel(panelId: string, webContentsId: number, taskIds: string[]): void {
    this.registry.set(panelId, { webContentsId, taskIds: new Set(taskIds) })
  }

  /** Replaces just the task linkage (edges changed), keeping the webContentsId. */
  setPanelTasks(panelId: string, taskIds: string[]): boolean {
    const panel = this.registry.get(panelId)
    if (!panel) return false
    panel.taskIds = new Set(taskIds)
    return true
  }

  unregisterPanel(panelId: string): boolean {
    return this.registry.delete(panelId)
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
    this.registry.clear()
  }

  private getLiveWebContents(webContentsId: number): Electron.WebContents | null {
    if (typeof webContentsId !== 'number') return null
    try {
      const wc = webContents.fromId(webContentsId)
      return wc && !wc.isDestroyed() ? wc : null
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
    return { ok: true, wc }
  }

  private async eval(wc: Electron.WebContents, script: string): Promise<Record<string, unknown>> {
    try {
      return unwrapEval(await wc.executeJavaScript(script, true))
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  async navigate(taskId: string, url: string, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    let target = (url || '').trim()
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target
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
      fn(wc)
    })
  }

  back(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.historyStep(taskId, (wc) => wc.goBack(), panelId)
  }

  forward(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.historyStep(taskId, (wc) => wc.goForward(), panelId)
  }

  reload(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.historyStep(taskId, (wc) => wc.reload(), panelId)
  }

  async snapshot(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    const result = parseSnapshotResult((await this.eval(resolved.wc, buildSnapshotScript())).value)
    if ('error' in result) return result
    return result as unknown as Record<string, unknown>
  }

  click(taskId: string, target: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.evalOnResolved(taskId, panelId, buildClickScript(target))
  }

  type(taskId: string, target: string, text: string, submit?: boolean, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.evalOnResolved(taskId, panelId, buildTypeScript(target, text, submit))
  }

  pressKey(taskId: string, key: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.evalOnResolved(taskId, panelId, buildPressScript(key))
  }

  scroll(taskId: string, direction?: string, amount?: number, target?: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.evalOnResolved(taskId, panelId, buildScrollScript(direction, amount, target))
  }

  get(taskId: string, what: string, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.evalOnResolved(taskId, panelId, buildGetScript(what))
  }

  wait(taskId: string, mode: 'selector' | 'text' | 'url', value: string, timeoutMs?: number, panelId?: string | null): Promise<Record<string, unknown>> {
    return this.evalOnResolved(taskId, panelId, buildWaitScript(mode, value, timeoutMs ?? 10000))
  }

  private async evalOnResolved(taskId: string, panelId: string | null | undefined, script: string): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    return this.eval(resolved.wc, script)
  }

  async screenshot(taskId: string, panelId?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolve(taskId, panelId)
    if (!resolved.ok) return resolved
    try {
      const image = await resolved.wc.capturePage()
      const dir = join(app.getPath('temp'), '20x-browser-screenshots')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${taskId}-${Date.now()}.png`)
      writeFileSync(file, image.toPNG())
      return { ok: true, path: file }
    } catch (err) {
      return { error: `Screenshot failed: ${(err as Error).message}` }
    }
  }
}

export const panelBrowserBroker = new PanelBrowserBroker()
