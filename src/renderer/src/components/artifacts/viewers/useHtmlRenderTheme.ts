import { useEffect, useState } from 'react'
import {
  HTML_RENDER_DEFAULT_THEME,
  HTML_RENDER_THEME_VARIABLES,
  type HtmlRenderTheme
} from '@shared/html-render'

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

/** Read the app's live theme (globals.css custom properties) so rendered
 * pages match exactly, including any future re-skin, without hardcoding
 * colours here. Falls back to the documented default palette when a variable
 * is not set (e.g. a test environment with no stylesheet loaded). */
function readTheme(): HtmlRenderTheme {
  const appearance = isDark() ? 'dark' : 'light'
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return HTML_RENDER_DEFAULT_THEME[appearance]
  }
  const computed = getComputedStyle(document.documentElement)
  const fallback = HTML_RENDER_DEFAULT_THEME[appearance]
  const theme: HtmlRenderTheme = { appearance }
  for (const name of HTML_RENDER_THEME_VARIABLES) {
    const value = computed.getPropertyValue(`--${name}`).trim()
    theme[name] = value || fallback[name]
  }
  return theme
}

function themesEqual(a: HtmlRenderTheme, b: HtmlRenderTheme): boolean {
  if (a.appearance !== b.appearance) return false
  return HTML_RENDER_THEME_VARIABLES.every((name) => a[name] === b[name])
}

/** Re-render when the app theme toggles (`.dark` class on `<html>`), same
 * MutationObserver pattern as MermaidDiagram — there is no shared theme
 * context in this app, each consumer observes independently. */
export function useHtmlRenderTheme(): HtmlRenderTheme {
  const [theme, setTheme] = useState<HtmlRenderTheme>(readTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = readTheme()
      setTheme((prev) => (themesEqual(prev, next) ? prev : next))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return theme
}
