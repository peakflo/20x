import { useEffect } from 'react'
import { useVoiceStore } from '@/stores/voice-store'

/** Set on `<html>` while the microphone is live. Read by `.app-chrome` in CSS. */
export const RECORDING_ATTRIBUTE = 'data-voice-recording'

/**
 * Turns the frame around the work deep crimson while the microphone is live.
 *
 * The colour lives in one CSS rule rather than in the four components that
 * make up the chrome — the top bar, the icon rail, the sidebar and the status
 * bar. Each of those only marks itself `app-chrome`; none of them knows
 * anything about voice, and adding a fifth surface later is a class, not a
 * subscription.
 *
 * It follows the **turn**, not the setting. Voice being switched on in
 * settings is not recording; a light that is on whenever the feature is
 * available tells the user nothing about whether they are being heard.
 */
export function useRecordingChrome(): void {
  const recording = useVoiceStore((s) => s.state === 'listening')

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const root = document.documentElement
    if (!recording) {
      root.removeAttribute(RECORDING_ATTRIBUTE)
      return undefined
    }
    root.setAttribute(RECORDING_ATTRIBUTE, 'true')
    // Unmounting mid-turn must not leave the window red for ever.
    return () => root.removeAttribute(RECORDING_ATTRIBUTE)
  }, [recording])
}
