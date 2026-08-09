import { useCallback, useEffect, useRef } from 'react'
import { Mic, MicOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useVoiceStore } from '@/stores/voice-store'
import type { VoiceTurnMode } from '@shared/voice'

interface VoiceMicButtonProps {
  /** `dictation` writes words into the focused field. `command` runs an action. */
  mode?: VoiceTurnMode
  className?: string
  title?: string
}

/**
 * Press-and-hold microphone control (design §5.8, phase 1).
 *
 * Holding the button opens the turn and releasing it closes the turn, so the
 * user always knows when the microphone is open. Releasing the pointer outside
 * the button, or pressing Escape, ends the turn as well — a stuck open
 * microphone must not be possible.
 */
export function VoiceMicButton({ mode = 'dictation', className = '', title }: VoiceMicButtonProps) {
  const available = useVoiceStore((s) => s.available)
  const enabled = useVoiceStore((s) => s.enabled)
  const state = useVoiceStore((s) => s.state)
  const turnId = useVoiceStore((s) => s.turnId)
  const level = useVoiceStore((s) => s.level)
  const startTurn = useVoiceStore((s) => s.startTurn)
  const endTurn = useVoiceStore((s) => s.endTurn)
  const cancel = useVoiceStore((s) => s.cancel)
  const holding = useRef(false)

  const stop = useCallback(() => {
    if (!holding.current) return
    holding.current = false
    void endTurn()
  }, [endTurn])

  useEffect(() => {
    if (!holding.current) return undefined
    const onPointerUp = (): void => stop()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        holding.current = false
        void cancel()
      }
    }
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [stop, cancel, turnId])

  if (!available || !enabled) return null

  const listening = turnId !== null && state === 'listening'
  const busy = state === 'transcribing' || state === 'executing'

  return (
    <Button
      type="button"
      variant={listening ? 'default' : 'ghost'}
      size="icon"
      disabled={busy}
      onPointerDown={(event) => {
        // Capture the pointer so a small hand movement does not end the turn,
        // and so the release always reaches this button.
        event.currentTarget.setPointerCapture?.(event.pointerId)
        holding.current = true
        void startTurn(mode)
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      className={`h-[32px] w-[32px] shrink-0 rounded-lg ${className}`}
      title={title ?? (mode === 'command' ? 'Hold to speak a command' : 'Hold to dictate')}
      aria-label={mode === 'command' ? 'Hold to speak a command' : 'Hold to dictate'}
      aria-pressed={listening}
      data-testid="voice-mic-button"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : listening ? (
        <Mic className="h-4 w-4" style={{ transform: `scale(${1 + Math.min(level, 1) * 0.35})` }} />
      ) : state === 'model_needed' ? (
        <MicOff className="h-4 w-4" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </Button>
  )
}
