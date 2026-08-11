import { useEffect } from 'react'
import { AlertTriangle, Check, Mic, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { selectVoiceReady, useVoiceStore } from '@/stores/voice-store'
import type { VoiceCandidate } from '@shared/voice'

const RESULT_VISIBLE_MS = 6000

/**
 * The in-app voice surface (design §5.3 and §5.5):
 *  - a listening indicator,
 *  - a live transcript bubble,
 *  - an explicit confirmation card for every action that needs one.
 *
 * Confirmation is always visual. A spoken "yes" never approves anything, so a
 * mis-heard word cannot start or approve work on its own.
 *
 * Reading aloud shows nothing. The user hears the answer, so a bubble that says
 * so tells them what they already know and covers the screen while it does it.
 * Escape still stops the reading, and so does speaking.
 */
export function VoiceOverlay() {
  // Hidden until the optional runtime is installed and voice is switched on.
  const ready = useVoiceStore(selectVoiceReady)
  const state = useVoiceStore((s) => s.state)
  const partial = useVoiceStore((s) => s.partial)
  const level = useVoiceStore((s) => s.level)
  const confirmation = useVoiceStore((s) => s.confirmation)
  const result = useVoiceStore((s) => s.result)
  const confirm = useVoiceStore((s) => s.confirm)
  const dismiss = useVoiceStore((s) => s.dismiss)
  const cancel = useVoiceStore((s) => s.cancel)
  const endTurn = useVoiceStore((s) => s.endTurn)
  const clearResult = useVoiceStore((s) => s.clearResult)
  // Nothing is drawn while an answer is read, but Escape must still stop it.
  const speaking = useVoiceStore((s) => s.speaking)
  const stopSpeaking = useVoiceStore((s) => s.stopSpeaking)

  // Escape cancels the current turn or the open confirmation.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (confirmation) void dismiss()
      else if (state === 'listening') void cancel()
      // Escape also stops speech. It is the one key a user reaches for when
      // the app is talking and they want it to stop.
      else if (speaking) void stopSpeaking()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmation, state, dismiss, cancel, speaking, stopSpeaking])

  useEffect(() => {
    if (!result) return undefined
    const timer = setTimeout(clearResult, RESULT_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [result, clearResult])

  if (!ready) return null

  const listening = state === 'listening'
  const transcribing = state === 'transcribing'
  const loudness = Math.min(Math.max(level, 0), 1)
  const showBubble = listening || transcribing || Boolean(partial)
  if (!showBubble && !confirmation && !result) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
      data-testid="voice-overlay"
    >
      {showBubble && (
        <div className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl border border-border bg-card/95 px-4 py-2.5 shadow-lg backdrop-blur">
          {/* The halo follows the voice in both light and size. The size was
              damped right down at one point and the movement became
              invisible, which is worse than restless. */}
          <span className="relative flex h-6 w-6 items-center justify-center" data-testid="voice-level">
            <span
              className="absolute inset-0 rounded-full bg-primary transition-all duration-75"
              style={{
                transform: `scale(${listening ? 0.7 + loudness * 1.0 : 0.7})`,
                opacity: listening ? 0.12 + loudness * 0.68 : 0.12,
              }}
              aria-hidden
            />
            <Mic
              className="relative h-3.5 w-3.5 text-primary transition-opacity duration-75"
              style={{ opacity: listening ? 0.5 + loudness * 0.5 : 1 }}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {/* One word for one state. "Listening — pause to send" read as
                  an instruction to do something, when it only described what
                  happens next by itself. */}
              {transcribing ? 'Writing the words' : 'Listening'}
            </p>
            {/* Only the words being spoken now. A sentence that was already
                sent is in the transcript above, and repeating it here says
                the same thing twice. */}
            <p className="truncate text-sm text-foreground" data-testid="voice-transcript">
              {partial || (transcribing ? 'One moment…' : 'Speak now')}
            </p>
          </div>
          {listening && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              onClick={() => void endTurn()}
              title="Stop listening. Escape throws the words away instead."
              aria-label="Stop listening"
              data-testid="voice-stop"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {confirmation && (
        <div
          className="pointer-events-auto w-full max-w-xl rounded-2xl border border-yellow-500/40 bg-card/98 p-4 shadow-xl backdrop-blur"
          role="alertdialog"
          aria-label="Confirm the voice command"
          data-testid="voice-confirmation"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{confirmation.proposal.summary}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Heard: “{confirmation.proposal.transcript}” · {reasonText(confirmation.reason)}
              </p>

              {confirmation.candidates && confirmation.candidates.length > 0 ? (
                <div className="mt-3 space-y-1.5">
                  {confirmation.candidates.map((candidate: VoiceCandidate) => (
                    <Button
                      key={`${candidate.kind}-${candidate.id}`}
                      size="sm"
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() =>
                        void confirm(
                          candidate.kind === 'task'
                            ? { taskId: candidate.id }
                            : { agentName: candidate.label }
                        )
                      }
                    >
                      {candidate.label}
                    </Button>
                  ))}
                  <Button size="sm" variant="ghost" className="w-full" onClick={() => void dismiss()}>
                    None of these
                  </Button>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" onClick={() => void confirm()} data-testid="voice-confirm-yes">
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Confirm
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void dismiss()}>
                    <X className="mr-1.5 h-3.5 w-3.5" />
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {result && (
        <div
          className={`pointer-events-auto max-w-xl rounded-xl border px-4 py-2 text-sm shadow-lg backdrop-blur ${
            result.kind === 'ok'
              ? 'border-border bg-card/95 text-foreground'
              : 'border-red-500/40 bg-card/95 text-red-400'
          }`}
          role="status"
          data-testid="voice-result"
        >
          {result.message}
        </div>
      )}
    </div>
  )
}

function reasonText(reason: string): string {
  switch (reason) {
    case 'destructive':
      return 'this answers the agent, so it needs a second confirmation'
    case 'ambiguous_task':
      return 'more than one task matches'
    case 'ambiguous_agent':
      return 'more than one agent matches'
    case 'low_confidence':
      return 'the words were not clear'
    default:
      return 'confirm to continue'
  }
}
