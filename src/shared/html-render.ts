/**
 * Shared constants and pure helpers for inline HTML renders (`html_render` /
 * `html_preview`). Used by the main process (tool routes, offscreen preview
 * capture), the renderer (iframe hardening, inline chat rendering) and the
 * mobile client (same iframe component via the `@` alias), so the limits, the
 * CSP string and the theme contract only exist in one place.
 */

// ── Input limits ─────────────────────────────────────────────────────────

export const HTML_RENDER_MIN_LENGTH = 1
export const HTML_RENDER_MAX_LENGTH = 512_000
export const HTML_RENDER_MAX_TITLE_LENGTH = 200
export const HTML_RENDER_MIN_HEIGHT = 80
export const HTML_RENDER_MAX_HEIGHT = 2000

export const HTML_PREVIEW_MIN_WIDTH = 240
export const HTML_PREVIEW_MAX_WIDTH = 1600
export const HTML_PREVIEW_DEFAULT_WIDTH = 728

export const HTML_RENDER_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const HTML_RENDER_MAX_PAGE_BYTES = 25 * 1024 * 1024

export const HTML_PREVIEW_MAX_CONCURRENT = 2
export const HTML_PREVIEW_TIMEOUT_MS = 20_000
export const HTML_PREVIEW_MAX_CONSOLE_MESSAGES = 20
export const HTML_PREVIEW_MAX_CONSOLE_TEXT_LENGTH = 500
export const HTML_PREVIEW_VIEWPORT_HEIGHT = 800
export const HTML_PREVIEW_MAX_CAPTURE_HEIGHT = 4000

export function clampHtmlRenderHeight(height: number): number {
  if (!Number.isFinite(height)) return HTML_RENDER_MIN_HEIGHT
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)))
}

export function clampHtmlPreviewWidth(width: number | undefined): number {
  if (!Number.isFinite(width)) return HTML_PREVIEW_DEFAULT_WIDTH
  return Math.min(HTML_PREVIEW_MAX_WIDTH, Math.max(HTML_PREVIEW_MIN_WIDTH, Math.round(width as number)))
}

/** Strip filesystem-illegal characters for the "Save as…" default filename. */
export function htmlRenderFileName(title: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${base || 'page'}.html`
}

// ── Network policy ───────────────────────────────────────────────────────

/**
 * Pages may load scripts and styles only from these CDNs. Everything else is
 * blocked: no other network access (`connect-src 'none'`), images only from
 * `data:`/`blob:`, no frames, and no forms posting out. Applied identically to
 * the inline chat frame, the artifact panel, mobile, and the `html_preview`
 * offscreen renderer — never weakened per-surface.
 */
export const HTML_RENDER_ALLOWED_CDNS = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com'
] as const

export function buildHtmlRenderCsp(): string {
  const cdns = HTML_RENDER_ALLOWED_CDNS.join(' ')
  return [
    "default-src 'none'",
    "connect-src 'none'",
    'img-src data: blob:',
    'media-src data: blob:',
    `style-src 'unsafe-inline' data: ${cdns}`,
    `script-src 'unsafe-inline' data: ${cdns}`,
    `font-src data: ${cdns}`,
    "frame-src 'none'",
    "form-action 'none'"
  ].join('; ')
}

// ── Theme contract ───────────────────────────────────────────────────────

/** CSS variable names a rendered page may read via `var(--…)`. Mirrors the
 * app's own design tokens (globals.css) plus a 6-colour categorical series
 * for charts. Documented verbatim in the `html_render`/`html_preview` tool
 * descriptions so agents know what is available. */
export const HTML_RENDER_THEME_VARIABLES = [
  'background', 'foreground', 'card', 'card-foreground',
  'muted', 'muted-foreground', 'border',
  'primary', 'primary-foreground',
  'success', 'success-foreground',
  'warning', 'warning-foreground',
  'destructive', 'destructive-foreground',
  'radius', 'font-sans', 'font-mono',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6'
] as const

export type HtmlRenderThemeVariable = typeof HTML_RENDER_THEME_VARIABLES[number]

export type HtmlRenderAppearance = 'light' | 'dark'

export type HtmlRenderTheme = {
  appearance: HtmlRenderAppearance
} & Partial<Record<HtmlRenderThemeVariable, string>>

/** Fallback palette used where there is no live app window to read computed
 * styles from (the offscreen `html_preview` renderer), and as a last resort
 * if a live read comes back empty. Mirrors `renderer/src/styles/globals.css`. */
export const HTML_RENDER_DEFAULT_THEME: Record<HtmlRenderAppearance, HtmlRenderTheme> = {
  light: {
    appearance: 'light',
    background: '#f4f4f5',
    foreground: '#121212',
    card: '#ffffff',
    'card-foreground': '#121212',
    muted: '#eeeeef',
    'muted-foreground': '#8e8d91',
    border: '#e3e2e4',
    primary: '#1e96eb',
    'primary-foreground': '#ffffff',
    success: '#10cb86',
    'success-foreground': '#ffffff',
    warning: '#ffab17',
    'warning-foreground': '#3a2800',
    destructive: '#eb4335',
    'destructive-foreground': '#ffffff',
    radius: '10px',
    'font-sans': '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    'font-mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    'chart-1': '#1e96eb',
    'chart-2': '#10cb86',
    'chart-3': '#f59e0b',
    'chart-4': '#a855f7',
    'chart-5': '#ec4899',
    'chart-6': '#06b6d4'
  },
  dark: {
    appearance: 'dark',
    background: '#141414',
    foreground: '#eaeaea',
    card: '#1e1e1e',
    'card-foreground': '#eaeaea',
    muted: '#232323',
    'muted-foreground': '#8e8d91',
    border: '#2d2d2d',
    primary: '#1e96eb',
    'primary-foreground': '#ffffff',
    success: '#10cb86',
    'success-foreground': '#06140d',
    warning: '#ffab17',
    'warning-foreground': '#1a1200',
    destructive: '#eb4335',
    'destructive-foreground': '#ffffff',
    radius: '10px',
    'font-sans': '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    'font-mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    'chart-1': '#4db8ff',
    'chart-2': '#34e2a6',
    'chart-3': '#fbbf24',
    'chart-4': '#c084fc',
    'chart-5': '#fb7185',
    'chart-6': '#22d3ee'
  }
}

/** Build the `:root{...}` body (no wrapping `<style>` tag) for a theme. Used
 * both for the initial baked-in style tag and for the live postMessage update
 * payload, so the two stay byte-identical for the same theme. */
export function htmlRenderThemeCssText(theme: HtmlRenderTheme): string {
  const declarations = HTML_RENDER_THEME_VARIABLES
    .filter((name) => typeof theme[name] === 'string' && theme[name])
    .map((name) => `--${name}:${theme[name]};`)
    .join('')
  return `:root{${declarations}color-scheme:${theme.appearance};}`
}

/**
 * The CSP meta tag + base href + initial theme style, shared by every
 * surface that renders an inline HTML page: the renderer's
 * `hardenArtifactHtml` (which appends its own interactive scripts — resize
 * reporting, live theme updates, the MCP tool bridge) and the main-process
 * `html_preview` offscreen capture (which needs nothing interactive, just an
 * identically themed, identically sandboxed document to screenshot).
 *
 * No theme: stays neutral (`color-scheme: light dark`) so the page's own
 * `prefers-color-scheme` media query decides.
 */
export function htmlRenderDocumentShell(theme?: HtmlRenderTheme): string {
  const themeCss = theme ? htmlRenderThemeCssText(theme) : ':root{color-scheme:light dark;}'
  // A page that uses `.dark` selectors (mirroring the host app's own pattern)
  // needs the class set from the first paint too, not just on a later
  // postMessage update. Safe this early: `document.documentElement` exists
  // as soon as parsing starts, before <body> is even in the source text.
  const darkClassScript = theme ? `<script>document.documentElement.classList.toggle('dark',${theme.appearance === 'dark'});</script>` : ''
  return `<meta http-equiv="Content-Security-Policy" content="${buildHtmlRenderCsp()}"><base href="about:blank"><style id="20x-theme">${themeCss}</style>${darkClassScript}`
}

/** Prepend the shell to `html`, after any leading `<!doctype>` (never after a
 * textual `<head>` match — see `hardenArtifactHtml`'s own comment for why). */
export function applyHtmlRenderShell(html: string, theme?: HtmlRenderTheme): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const rest = doctype ? html.slice(doctype[0].length) : html
  return `<!doctype html>${htmlRenderDocumentShell(theme)}${rest}`
}

// ── Host ⇄ frame message protocol ────────────────────────────────────────
// One-way notifications (not JSON-RPC like the MCP tool bridge): the frame
// reports its content height as it changes; the host pushes theme updates
// without reloading the document.

export const HTML_RENDER_SIZE_MESSAGE_TYPE = '20x-artifact-size'
export const HTML_RENDER_THEME_MESSAGE_TYPE = '20x-artifact-theme'

export interface HtmlRenderSizeMessage {
  type: typeof HTML_RENDER_SIZE_MESSAGE_TYPE
  height: number
}

export interface HtmlRenderThemeMessage {
  type: typeof HTML_RENDER_THEME_MESSAGE_TYPE
  theme: HtmlRenderTheme
}

export function isHtmlRenderSizeMessage(data: unknown): data is HtmlRenderSizeMessage {
  return !!data && typeof data === 'object'
    && (data as { type?: unknown }).type === HTML_RENDER_SIZE_MESSAGE_TYPE
    && typeof (data as { height?: unknown }).height === 'number'
    && Number.isFinite((data as { height: number }).height)
}

export function isHtmlRenderThemeMessage(data: unknown): data is HtmlRenderThemeMessage {
  return !!data && typeof data === 'object'
    && (data as { type?: unknown }).type === HTML_RENDER_THEME_MESSAGE_TYPE
    && !!(data as { theme?: unknown }).theme && typeof (data as { theme: unknown }).theme === 'object'
}

// ── Agent-facing documentation fragments ─────────────────────────────────
// Reused verbatim in the `html_render`/`html_preview` tool descriptions so the
// authoring contract travels with the tool schema, not just the system prompt.

export const HTML_RENDER_THEME_GUIDE =
  `Theme variables (read with var(--name)): ${HTML_RENDER_THEME_VARIABLES.map((name) => `--${name}`).join(', ')}. `
  + 'When no theme has been pushed yet, defaults follow prefers-color-scheme.'

export const HTML_RENDER_LAYOUT_GUIDE =
  'Layout rules: no background on html/body (the page sits on the chat background); fluid width, no fixed page width; '
  + 'no outer card or title (the toolbar already shows the title); give charts a fixed pixel height, never 100vh; use the theme variables above.'

export const HTML_RENDER_NETWORK_POLICY =
  `Network policy: scripts and styles may load only from ${HTML_RENDER_ALLOWED_CDNS.join(', ')}. `
  + 'Everything else is blocked — no other network access, images only as data:/blob: URIs, no frames, no forms posting out.'

export const HTML_RENDER_DONT_NARRATE =
  "Shown in the conversation above your reply. Don't describe or repeat it; add only what it doesn't already say."
