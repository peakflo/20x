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
 * The colour is applied by one CSS rule to anything marked `app-chrome`, so
 * these check the contract between the two halves rather than a rendered
 * pixel — happy-dom does not apply the stylesheet.
 */
describe('the chrome contract', () => {
  const css = readFileSync(join(__dirname, '../styles/globals.css'), 'utf-8')

  it('tints every surface that marks itself as chrome', () => {
    const rule = css.slice(css.indexOf(`[${RECORDING_ATTRIBUTE}="true"] .app-chrome`))
    expect(rule).toContain('--color-background: var(--recording-chrome)')
    // Text and hairlines have to move with the fill or they become unreadable.
    expect(rule).toContain('--color-foreground:')
    expect(rule).toContain('--color-muted-foreground:')
    expect(rule).toContain('--color-border:')
  })

  it('uses a deep crimson in both themes', () => {
    expect(css).toContain('--recording-chrome: #8b1e3f')
    expect(css).toContain('--recording-chrome: #7a1626')
  })

  it('overrides the bridged tokens, not the raw ones', () => {
    // `--color-background: var(--background)` resolves once on :root, so
    // overriding `--background` deeper in the tree does nothing at all.
    const rule = css.slice(
      css.indexOf(`[${RECORDING_ATTRIBUTE}="true"] .app-chrome`),
      css.indexOf('prefers-reduced-motion')
    )
    expect(rule).not.toMatch(/^\s*--background:/m)
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
