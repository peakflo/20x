import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { selectVoiceReady, useVoiceStore } from '@/stores/voice-store'
import {
  clearActiveComposer,
  composerCanSubmit,
  findComposerField,
  findComposerKey,
  getActiveComposer,
  setActiveComposer,
  setDictationTarget,
} from '@/lib/voice-dictation-target'
import type { VoiceTurnMode } from '@shared/voice'

interface VoiceMicButtonProps {
  /** `dictation` writes words into the field beside it. `command` runs an action. */
  mode?: VoiceTurnMode
  /**
   * Sends the composer. Supplying it turns on the conversational loop: the
   * microphone stays open and every sentence is sent after a pause.
   */
  onSubmit?: () => void
  /**
   * Names the composer to dictate into, instead of looking for one around the
   * button. A control that sits outside every composer — the top-bar
   * microphone — must say where the words go, or they go nowhere.
   */
  composerKey?: string
  /** Runs just before a turn starts, to make that composer visible. */
  onBeforeStart?: () => void
  /**
   * How loudly the button asks to be used.
   *
   * `quiet` sits beside a text field, where the field is the subject. `strong`
   * is for a place where speaking is the point rather than one option among
   * several — the top bar.
   *
   * The difference is colour, never size. A microphone that grows is a
   * different-looking control; a microphone that carries the accent colour is
   * the same control, asking to be used.
   */
  emphasis?: 'quiet' | 'strong'
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
  composerKey,
  onBeforeStart,
  emphasis = 'quiet',
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

  // The composer this button belongs to. Resolved after mount for a button that
  // sits inside one; given outright by a button that sits outside every
  // composer, like the one in the top bar.
  const [myKey, setMyKey] = useState<string | null>(composerKey ?? null)
  useEffect(() => {
    setMyKey(composerKey ?? findComposerKey(buttonRef.current))
  }, [composerKey])

  /**
   * The open turn is writing into this button's composer, whoever started it.
   *
   * Without this, starting from the top bar left the microphone beside the
   * Mastermind box looking idle — and disabled — while it was the box receiving
   * every word. The recording state belongs where the words land, not only
   * where the click happened.
   */
  const ownsByComposer = Boolean(turnId && myKey && getActiveComposer() === myKey)
  const mine = owns.current || ownsByComposer

  const listening = mine && turnId !== null && state === 'listening'

  const toggle = useCallback(() => {
    // Either button can stop the turn it shares: the one that started it, and
    // the one beside the box the words are going into.
    if (mine && turnId) {
      owns.current = false
      void endTurn()
      return
    }
    if (turnId) return // another control is listening
    owns.current = true
    onBeforeStart?.()

    // A composer that can send, plus the conversation setting, gives the
    // hands-free loop: speak, pause, it sends, and it keeps listening.
    const namedCanSubmit = composerKey ? composerCanSubmit(composerKey) : false
    const loop = mode === 'dictation' && conversational && (Boolean(onSubmit) || namedCanSubmit)
    if (mode === 'dictation') {
      // Prefer the composer key: it survives the panel being rebuilt, which
      // happens as soon as an agent session starts.
      const key = composerKey ?? findComposerKey(buttonRef.current)
      if (key) setActiveComposer(key)
      else setDictationTarget(findComposerField(buttonRef.current), loop ? onSubmit : undefined)
    }
    void startTurn(loop ? 'conversation' : mode).then(() => {
      if (!useVoiceStore.getState().turnId) owns.current = false
    })
  }, [mine, turnId, endTurn, startTurn, mode, conversational, onSubmit, composerKey, onBeforeStart])

  // Escape drops the turn without inserting anything.
  useEffect(() => {
    if (!listening) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      owns.current = false
      clearActiveComposer()
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
  // Idle emphasis is a tint and the accent colour, so the control keeps its
  // size and only its weight changes.
  const accent =
    emphasis === 'strong' && !listening && !busy
      ? 'text-primary bg-primary/10 hover:bg-primary/20 hover:text-primary'
      : ''
  const otherIsListening = !mine && turnId !== null

  return (
    <Button
      ref={buttonRef}
      type="button"
      variant={listening ? 'default' : 'ghost'}
      size="icon"
      disabled={busy || otherIsListening}
      onClick={toggle}
      className={`h-[32px] w-[32px] shrink-0 rounded-lg ${accent} ${className}`}
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
