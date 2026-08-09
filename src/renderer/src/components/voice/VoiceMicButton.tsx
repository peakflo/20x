import { useCallback, useEffect, useRef } from 'react'
import { Mic, Square, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { selectVoiceReady, useVoiceStore } from '@/stores/voice-store'
import { findComposerField, setDictationTarget } from '@/lib/voice-dictation-target'
import type { VoiceTurnMode } from '@shared/voice'

interface VoiceMicButtonProps {
  /** `dictation` writes words into the field beside it. `command` runs an action. */
  mode?: VoiceTurnMode
  /**
   * Sends the composer. Supplying it turns on the conversational loop: the
   * microphone stays open and every sentence is sent after a pause.
   */
  onSubmit?: () => void
  className?: string
  title?: string
}

/**
 * Microphone control (design §5.8, phase 1).
 *
 * One click starts listening and a second click stops it. Escape cancels the
 * turn and keeps the words out.
 *
 * The button also decides where the words go: it claims the text field of its
 * own composer. Without that, one spoken sentence would land in every mounted
 * transcript panel at once.
 */
export function VoiceMicButton({
  mode = 'dictation',
  onSubmit,
  className = '',
  title,
}: VoiceMicButtonProps) {
  const conversational = useVoiceStore((s) => s.conversation)
  const ready = useVoiceStore(selectVoiceReady)
  const state = useVoiceStore((s) => s.state)
  const turnId = useVoiceStore((s) => s.turnId)
  const level = useVoiceStore((s) => s.level)
  const startTurn = useVoiceStore((s) => s.startTurn)
  const endTurn = useVoiceStore((s) => s.endTurn)
  const cancel = useVoiceStore((s) => s.cancel)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // True only for a turn this button started, so a second button never stops it.
  const owns = useRef(false)

  const listening = owns.current && turnId !== null && state === 'listening'

  const toggle = useCallback(() => {
    if (owns.current && turnId) {
      owns.current = false
      void endTurn()
      return
    }
    if (turnId) return // another control is listening
    owns.current = true
    // A composer that can send, plus the conversation setting, gives the
    // hands-free loop: speak, pause, it sends, and it keeps listening.
    const loop = mode === 'dictation' && conversational && Boolean(onSubmit)
    if (mode === 'dictation') {
      setDictationTarget(findComposerField(buttonRef.current), loop ? onSubmit : undefined)
    }
    void startTurn(loop ? 'conversation' : mode).then(() => {
      if (!useVoiceStore.getState().turnId) owns.current = false
    })
  }, [turnId, endTurn, startTurn, mode, conversational, onSubmit])

  // Escape drops the turn without inserting anything.
  useEffect(() => {
    if (!listening) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      owns.current = false
      setDictationTarget(null)
      void cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [listening, cancel])

  // Release ownership when the turn ends for any other reason.
  useEffect(() => {
    if (!turnId) owns.current = false
  }, [turnId])

  if (!ready) return null

  const busy = state === 'transcribing' || state === 'executing'
  const otherIsListening = !owns.current && turnId !== null

  return (
    <Button
      ref={buttonRef}
      type="button"
      variant={listening ? 'default' : 'ghost'}
      size="icon"
      disabled={busy || otherIsListening}
      onClick={toggle}
      className={`h-[32px] w-[32px] shrink-0 rounded-lg ${className}`}
      title={
        title ??
        (listening
          ? 'Click to stop'
          : mode === 'command'
            ? 'Click to speak a command'
            : conversational && onSubmit
              ? 'Click to talk. Each pause sends what you said.'
              : 'Click to dictate')
      }
      aria-label={listening ? 'Stop listening' : mode === 'command' ? 'Speak a command' : 'Dictate'}
      aria-pressed={listening}
      data-testid="voice-mic-button"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : listening ? (
        <Square
          className="h-3.5 w-3.5 fill-current"
          style={{ transform: `scale(${1 + Math.min(level, 1) * 0.3})` }}
        />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </Button>
  )
}
