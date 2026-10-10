import { describe, expect, it } from 'vitest'
import {
  applyHtmlRenderShell,
  buildHtmlRenderCsp,
  clampHtmlPreviewWidth,
  clampHtmlRenderHeight,
  htmlRenderFileName,
  htmlRenderThemeCssText,
  HTML_PREVIEW_DEFAULT_WIDTH,
  HTML_PREVIEW_MAX_WIDTH,
  HTML_PREVIEW_MIN_WIDTH,
  HTML_RENDER_ALLOWED_CDNS,
  HTML_RENDER_DEFAULT_THEME,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_SIZE_MESSAGE_TYPE,
  HTML_RENDER_THEME_MESSAGE_TYPE,
  HTML_RENDER_THEME_VARIABLES,
  isHtmlRenderSizeMessage,
  isHtmlRenderThemeMessage
} from './html-render'

describe('clampHtmlRenderHeight', () => {
  it('clamps below the minimum', () => {
    expect(clampHtmlRenderHeight(10)).toBe(HTML_RENDER_MIN_HEIGHT)
  })
  it('clamps above the maximum', () => {
    expect(clampHtmlRenderHeight(5000)).toBe(HTML_RENDER_MAX_HEIGHT)
  })
  it('rounds and passes through an in-range value', () => {
    expect(clampHtmlRenderHeight(420.6)).toBe(421)
  })
  it('falls back to the minimum for non-finite input', () => {
    expect(clampHtmlRenderHeight(NaN)).toBe(HTML_RENDER_MIN_HEIGHT)
    expect(clampHtmlRenderHeight(Infinity)).toBe(HTML_RENDER_MIN_HEIGHT)
  })
})

describe('clampHtmlPreviewWidth', () => {
  it('defaults when undefined', () => {
    expect(clampHtmlPreviewWidth(undefined)).toBe(HTML_PREVIEW_DEFAULT_WIDTH)
  })
  it('clamps to the min/max bounds', () => {
    expect(clampHtmlPreviewWidth(10)).toBe(HTML_PREVIEW_MIN_WIDTH)
    expect(clampHtmlPreviewWidth(99999)).toBe(HTML_PREVIEW_MAX_WIDTH)
  })
})

describe('htmlRenderFileName', () => {
  it('appends .html and strips illegal filesystem characters', () => {
    expect(htmlRenderFileName('Q3 Revenue: by region / team')).toBe('Q3 Revenue by region team.html')
  })
  it('falls back to a generic name when the title is empty after stripping', () => {
    expect(htmlRenderFileName('///')).toBe('page.html')
  })
})

describe('buildHtmlRenderCsp', () => {
  const csp = buildHtmlRenderCsp()
  it('allows scripts and styles only from the CDN allowlist', () => {
    for (const cdn of HTML_RENDER_ALLOWED_CDNS) {
      expect(csp).toContain(`script-src 'unsafe-inline' data: ${HTML_RENDER_ALLOWED_CDNS.join(' ')}`)
      expect(csp).toContain(cdn)
    }
  })
  it('blocks all other network access', () => {
    expect(csp).toContain("connect-src 'none'")
  })
  it('restricts images to data:/blob: only', () => {
    expect(csp).toContain('img-src data: blob:')
  })
  it('blocks frames and form submission', () => {
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("form-action 'none'")
  })
  it('never allows a default-src escape hatch', () => {
    expect(csp).toContain("default-src 'none'")
  })
})

describe('htmlRenderThemeCssText', () => {
  it('emits every declared variable plus color-scheme', () => {
    const css = htmlRenderThemeCssText(HTML_RENDER_DEFAULT_THEME.dark)
    expect(css).toContain('color-scheme:dark;')
    for (const name of HTML_RENDER_THEME_VARIABLES) {
      expect(css).toContain(`--${name}:${HTML_RENDER_DEFAULT_THEME.dark[name]};`)
    }
  })
  it('omits unset variables rather than emitting empty declarations', () => {
    const css = htmlRenderThemeCssText({ appearance: 'light' })
    expect(css).toBe(':root{color-scheme:light;}')
  })
})

describe('applyHtmlRenderShell', () => {
  it('inserts the shell immediately after a leading doctype', () => {
    const result = applyHtmlRenderShell('<!doctype html><html><body>hi</body></html>', HTML_RENDER_DEFAULT_THEME.dark)
    expect(result.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(result).toContain('<html><body>hi</body></html>')
  })
  it('inserts the shell even without a doctype', () => {
    const result = applyHtmlRenderShell('<html><body>hi</body></html>')
    expect(result.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
  })
  it('stays theme-neutral (prefers-color-scheme) when no theme is given', () => {
    const result = applyHtmlRenderShell('<p>x</p>')
    expect(result).toContain(':root{color-scheme:light dark;}')
  })
  it('never weakens the CSP regardless of content', () => {
    const result = applyHtmlRenderShell('<script>alert(1)</script>')
    expect(result).toContain(buildHtmlRenderCsp())
  })
})

describe('html render message protocol', () => {
  it('recognizes a well-formed size message and rejects malformed ones', () => {
    expect(isHtmlRenderSizeMessage({ type: HTML_RENDER_SIZE_MESSAGE_TYPE, height: 240 })).toBe(true)
    expect(isHtmlRenderSizeMessage({ type: HTML_RENDER_SIZE_MESSAGE_TYPE, height: 'tall' })).toBe(false)
    expect(isHtmlRenderSizeMessage({ type: HTML_RENDER_SIZE_MESSAGE_TYPE, height: NaN })).toBe(false)
    expect(isHtmlRenderSizeMessage({ type: 'other', height: 240 })).toBe(false)
    expect(isHtmlRenderSizeMessage(null)).toBe(false)
    expect(isHtmlRenderSizeMessage('not an object')).toBe(false)
  })

  it('recognizes a well-formed theme message and rejects malformed ones', () => {
    expect(isHtmlRenderThemeMessage({ type: HTML_RENDER_THEME_MESSAGE_TYPE, theme: { appearance: 'dark' } })).toBe(true)
    expect(isHtmlRenderThemeMessage({ type: HTML_RENDER_THEME_MESSAGE_TYPE, theme: null })).toBe(false)
    expect(isHtmlRenderThemeMessage({ type: 'other', theme: {} })).toBe(false)
  })
})
