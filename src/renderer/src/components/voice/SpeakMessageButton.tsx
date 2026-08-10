import { Square, Volume2 } from 'lucide-react'
import { selectSpeechReady, useVoiceStore } from '@/stores/voice-store'

interface SpeakMessageButtonProps {
  text: string
  taskId?: string
}

/**
 * Reads one message aloud.
 *
 * It is the only way to hear an answer that 20x decided not to read by itself:
 * an answer to a typed question, an answer that was cut at the character limit,
 * or an answer from a task the user was not asking about.
 *
 * It appears only when a voice is loaded, so it never offers something that
 * cannot happen. It subscribes to the store itself rather than taking state
 * through props, so a memoised message row does not re-render while an answer
 * is streaming.
 */
export function SpeakMessageButton({ text, taskId }: SpeakMessageButtonProps) {
  const ready = useVoiceStore(selectSpeechReady)
  const speaking = useVoiceStore((s) => s.speaking)
  const speechText = useVoiceStore((s) => s.speechText)
  const speakText = useVoiceStore((s) => s.speakText)
  const stopSpeaking = useVoiceStore((s) => s.stopSpeaking)

  if (!ready || !text.trim()) return null

  // The spoken passage is a cleaned version of the message, so the two are
  // compared by their opening words rather than by equality.
  const isThisOne = speaking && speechText.length > 0 && text.trim().startsWith(speechText.slice(0, 24))

  return (
    <button
      type="button"
      className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => (isThisOne ? void stopSpeaking() : void speakText(text, taskId))}
      title={isThisOne ? 'Stop reading' : 'Read this aloud'}
      aria-label={isThisOne ? 'Stop reading' : 'Read this aloud'}
      data-testid="speak-message"
    >
      {isThisOne ? <Square className="h-3 w-3 fill-current" /> : <Volume2 className="h-3 w-3" />}
    </button>
  )
}
