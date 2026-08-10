import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { RECORDING_ATTRIBUTE, useRecordingChrome } from './use-recording-chrome'
import { useVoiceStore } from '@/stores/voice-store'

/**
 * The recording signal on the window frame.
 *
 * The rule this file protects: the colour follows the **turn**, not the
 * setting. A frame that is red whenever voice is available tells the user
 * nothing about whether they are being heard.
 */

function Harness(): null {
  useRecordingChrome()
  return null
}

const isRecording = (): boolean =>
  document.documentElement.getAttribute(RECORDING_ATTRIBUTE) === 'true'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.documentElement.removeAttribute(RECORDING_ATTRIBUTE)
  useVoiceStore.setState({ enabled: true, state: 'idle', turnId: null })
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute(RECORDING_ATTRIBUTE)
})

describe('useRecordingChrome', () => {
  it('marks the document while the microphone is live', () => {
    render(<Harness />)
    expect(isRecording()).toBe(false)

    act(() => {
      useVoiceStore.setState({ state: 'listening', turnId: 'turn-1' })
    })
    expect(isRecording()).toBe(true)
  })

  it('clears the mark when the turn ends', () => {
    render(<Harness />)
    act(() => {
      useVoiceStore.setState({ state: 'listening', turnId: 'turn-1' })
    })
    act(() => {
      useVoiceStore.setState({ state: 'idle', turnId: null })
    })
    expect(isRecording()).toBe(false)
  })

  it('stays off while voice is merely switched on', () => {
    // Available is not recording. This is the whole point of the signal.
    render(<Harness />)
    act(() => {
      useVoiceStore.setState({ enabled: true, state: 'idle' })
    })
    expect(isRecording()).toBe(false)
  })

  it('stays off while the words are being written up', () => {
    render(<Harness />)
    act(() => {
      useVoiceStore.setState({ state: 'transcribing', turnId: 'turn-1' })
    })
    // The microphone is closed by then; a red frame would be a lie.
    expect(isRecording()).toBe(false)
  })

  it('does not leave the window red when it unmounts mid-turn', () => {
    const view = render(<Harness />)
    act(() => {
      useVoiceStore.setState({ state: 'listening', turnId: 'turn-1' })
    })
    expect(isRecording()).toBe(true)

    view.unmount()
    expect(isRecording()).toBe(false)
  })
})

/**
 * The colour is applied by CSS, so these check the contract rather than a
 * rendered pixel — happy-dom applies no stylesheet.
 */
describe('the recording surface', () => {
  const css = readFileSync(join(__dirname, '../styles/globals.css'), 'utf-8')
  const chromeRule = css.slice(css.indexOf(`[${RECORDING_ATTRIBUTE}="true"] .app-chrome`))

  it('tints the three chrome strips', () => {
    expect(chromeRule).toContain('--color-background: color-mix(')
    // The sidebar floats as a card, so it fills from `--card` rather than
    // `--background` and would otherwise be the one strip that stayed grey.
    expect(chromeRule).toContain('--color-card: color-mix(')
    // Hairlines and hover have to move with the fill or they disappear.
    expect(chromeRule).toContain('--color-border: color-mix(')
    expect(chromeRule).toContain('--color-accent: color-mix(')
  })

  it('leaves the work alone', () => {
    // Tinting the card underneath turned the task window pink. A signal must
    // not sit on top of what the user is reading.
    //
    // The guarantee is the selector, not a list of banned properties: every
    // recording rule has to be scoped to a marked strip, so nothing it sets
    // can reach the workspace, the gutters or the window field.
    const recording = css.slice(css.indexOf('── Recording ──'))
    const withoutComments = recording.replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = [...withoutComments.matchAll(/(^|\})\s*([^{}@]+)\{/g)]
      .map((match) => match[2].trim())
      .filter((selector) => selector && !/^\d|%$/.test(selector))

    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector, `${selector} must be scoped to a chrome strip`).toContain('.app-chrome')
    }

    // And the theme's own surfaces are exactly what they were.
    expect(css).toContain('--card: #ffffff')
    expect(css).toContain('--card: #1e1e1e')
    expect(css).toContain('--background: #f4f4f5')
    expect(css).toContain('--background: #141414')
    expect(css).not.toContain('--card-base')
  })

  it('takes its colour from the design tokens, never a new hex', () => {
    const declarations = chromeRule.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).toContain('var(--destructive)')
    expect(declarations).toContain('var(--primary)')
    // Aperture has one red and one azure. A crimson of our own was the first
    // attempt and it belonged to nothing.
    expect(declarations).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toContain('recording-chrome')
  })

  it('overrides the bridged tokens, not the raw ones', () => {
    // `--color-background: var(--background)` resolves once on :root, so a
    // deeper override of `--background` is silently ignored — it looks like
    // nothing happening rather than like an error.
    const declarations = chromeRule.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toMatch(/^\s*--background\s*:/m)
  })

  it('moves slowly, and holds still when motion is unwelcome', () => {
    expect(css).toContain('@keyframes recording-drift')
    expect(chromeRule).toMatch(/animation: recording-drift \d+s/)
    const reduced = css.slice(css.indexOf('prefers-reduced-motion: reduce'))
    expect(reduced).toContain('animation: none')
  })
})

describe('the surfaces that carry the mark', () => {
  const layout = join(__dirname, '../components/layout')

  it('floats every panel the same way', () => {
    const appLayout = readFileSync(join(layout, 'AppLayout.tsx'), 'utf-8')
    const sidebar = readFileSync(join(layout, 'Sidebar.tsx'), 'utf-8')
    const drawer = readFileSync(
      join(layout, '../orchestrator/OrchestratorPanel.tsx'),
      'utf-8'
    )

    const panels = {
      workspace: appLayout.slice(appLayout.indexOf('<main'), appLayout.indexOf('</main>')),
      sidebar: sidebar.slice(sidebar.indexOf('<aside'), sidebar.indexOf('>', sidebar.indexOf('<aside'))),
      // The Mastermind drawer was the last one still flush and square.
      mastermind: drawer.slice(drawer.indexOf('return ('), drawer.indexOf('{/* Header')),
    }

    // One shape language. A panel that opts out reads as unfinished beside
    // the others.
    for (const [name, markup] of Object.entries(panels)) {
      for (const shape of ['rounded-2xl', 'border border-border', 'bg-card', 'shadow-card']) {
        expect(markup, `${name} should carry ${shape}`).toContain(shape)
      }
    }
  })

  it('paints the field the panels float on', () => {
    // The gutters between the cards must be the theme surface, not whatever
    // happens to be behind an unpainted element.
    const appLayout = readFileSync(join(layout, 'AppLayout.tsx'), 'utf-8')
    const row = appLayout.slice(appLayout.indexOf('Content area:'))
    expect(row.slice(0, 300)).toContain('bg-background')
  })

  it.each([
    ['AppLayout.tsx', 2],
    ['Sidebar.tsx', 1],
    ['StatusBar.tsx', 1],
  ])('%s marks its chrome', (file, count) => {
    const source = readFileSync(join(layout, file), 'utf-8')
    expect(source.split('app-chrome').length - 1).toBe(count)
  })
})
