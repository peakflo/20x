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
 * The colour is applied by CSS to the whole window, so these check the
 * contract rather than a rendered pixel — happy-dom applies no stylesheet.
 */
describe('the recording surface', () => {
  const css = readFileSync(join(__dirname, '../styles/globals.css'), 'utf-8')
  const rule = css.slice(css.indexOf(`[${RECORDING_ATTRIBUTE}="true"] {`))

  it('tints the whole window, not only the frame', () => {
    // Tinting the chrome alone read as a red border around a grey middle.
    expect(rule).toContain('--background: color-mix(')
    expect(rule).toContain('--card: color-mix(')
  })

  it('takes its colour from the design tokens, never a new hex', () => {
    // From the first rule, so the prose above it — which names the token
    // values — is not mistaken for a declaration.
    const recording = css.slice(css.indexOf(`[${RECORDING_ATTRIBUTE}="true"] {`))
    const declarations = recording.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).toContain('var(--destructive)')
    expect(declarations).toContain('var(--primary)')
    // Aperture has one red and one azure. A crimson of our own was the first
    // attempt and it belonged to nothing.
    expect(declarations).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toContain('recording-chrome')
  })

  it('mixes from a base token, because a property cannot refer to itself', () => {
    // `--background: color-mix(… var(--background) …)` is dropped outright,
    // which shows up as no tint at all rather than as an error.
    expect(rule).toContain('var(--background-base)')
    expect(rule).toContain('var(--card-base)')
    expect(css).toContain('--background: var(--background-base)')
    expect(css).toContain('--card: var(--card-base)')
  })

  it('moves slowly, and holds still when motion is unwelcome', () => {
    expect(css).toContain('@keyframes recording-drift')
    expect(css).toMatch(/animation: recording-drift \d+s/)
    const reduced = css.slice(css.indexOf('prefers-reduced-motion: reduce'))
    expect(reduced).toContain('animation: none')
  })

  it('lets the one field show through the chrome', () => {
    // Transparent strips over a single background, rather than four fills
    // that have to agree with each other.
    const chrome = css.slice(css.indexOf(`[${RECORDING_ATTRIBUTE}="true"] .app-chrome`))
    expect(chrome).toContain('background-color: transparent')
  })
})

describe('the surfaces that carry the mark', () => {
  const layout = join(__dirname, '../components/layout')

  it.each([
    ['AppLayout.tsx', 2],
    ['Sidebar.tsx', 1],
    ['StatusBar.tsx', 1],
  ])('%s marks its chrome', (file, count) => {
    const source = readFileSync(join(layout, file), 'utf-8')
    expect(source.split('app-chrome').length - 1).toBe(count)
  })
})
