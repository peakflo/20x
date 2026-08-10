import { useEffect, useState } from 'react'
import { Download, Loader2, Play, Square, Trash2, Volume2 } from 'lucide-react'
import { SettingsSection } from '../SettingsSection'
import { AdvancedDisclosure } from '../AdvancedDisclosure'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { settingsApi } from '@/lib/ipc-client'
import { useVoiceStore } from '@/stores/voice-store'
import { VOICE_SETTING_KEYS } from '@shared/voice'
import { VOICE_TTS_MAX_CHARS_CHOICES, VOICE_TTS_SPEED_CHOICES, type VoiceTtsEngineId } from '@shared/voice-tts'

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} kB`
}

/**
 * Spoken answers — the speaking half of the voice page (design §5.7 and §5.10).
 *
 * The main view holds what a user acts on: read answers aloud, choose a voice,
 * hear it, and download a better one. The settings that already have a good
 * default — the engine, the speed, the length limit and the two answer rules —
 * sit behind this half's own disclosure, separate from the listening one.
 */
export function SpokenAnswerSettings() {
  const tts = useVoiceStore((s) => s.tts)
  const speaking = useVoiceStore((s) => s.speaking)
  const initializeTts = useVoiceStore((s) => s.initializeTts)
  const setTtsEnabled = useVoiceStore((s) => s.setTtsEnabled)
  const setTtsEngine = useVoiceStore((s) => s.setTtsEngine)
  const setTtsVoice = useVoiceStore((s) => s.setTtsVoice)
  const setTtsSpeed = useVoiceStore((s) => s.setTtsSpeed)
  const setTtsMaxChars = useVoiceStore((s) => s.setTtsMaxChars)
  const setTtsSpeakActionResults = useVoiceStore((s) => s.setTtsSpeakActionResults)
  const setTtsOnlyVoiceTurns = useVoiceStore((s) => s.setTtsOnlyVoiceTurns)
  const installTtsModel = useVoiceStore((s) => s.installTtsModel)
  const selectTtsModel = useVoiceStore((s) => s.selectTtsModel)
  const removeTtsModel = useVoiceStore((s) => s.removeTtsModel)
  const previewVoice = useVoiceStore((s) => s.previewVoice)
  const stopSpeaking = useVoiceStore((s) => s.stopSpeaking)

  const [advanced, setAdvanced] = useState(false)
  const [advancedReady, setAdvancedReady] = useState(false)

  useEffect(() => {
    void initializeTts()
    void settingsApi.get(VOICE_SETTING_KEYS.advancedTts).then((v) => {
      setAdvanced(v === 'true')
      // The disclosure keeps its own open state, so it may only be drawn once
      // the stored answer is known.
      setAdvancedReady(true)
    })
  }, [initializeTts])

  const rememberAdvanced = (next: boolean): void => {
    setAdvanced(next)
    void settingsApi.set(VOICE_SETTING_KEYS.advancedTts, next ? 'true' : 'false')
  }

  if (!tts) {
    return (
      <SettingsSection
        title="Text to speech — what 20x says"
        description="20x can read an agent answer aloud."
      >
        <p className="text-sm text-muted-foreground">Spoken answers are not available in this build.</p>
      </SettingsSection>
    )
  }

  const ready = tts.status.state === 'ready'
  const statusLine =
    tts.status.state === 'ready'
      ? tts.status.engine === 'system'
        ? 'Ready — the voice installed in this system.'
        : `Ready — ${tts.status.modelId}.`
      : tts.status.state === 'loading'
        ? 'The voice is loading.'
        : tts.status.message

  return (
    <SettingsSection
      title="Text to speech — what 20x says"
      description="20x reads an agent answer aloud. The speech is produced on this computer; no text and no audio leave the device."
    >
      <div className="flex items-center justify-between rounded-lg border border-border p-3">
        <div className="space-y-0.5">
          <Label className="flex items-center gap-2">
            <Volume2 className="h-4 w-4" />
            Read agent answers aloud
          </Label>
          <p className="text-xs text-muted-foreground">
            A code block, a table, a file path and a link are never read. They are named instead.
          </p>
        </div>
        <Switch
          checked={tts.enabled}
          onCheckedChange={(next) => void setTtsEnabled(next)}
          data-testid="tts-enabled-switch"
        />
      </div>

      {/* A problem is never hidden. When all is well this says nothing. */}
      {!ready && (
        <div className="rounded-lg border border-yellow-500/40 p-3 text-sm">
          <p className="text-muted-foreground" data-testid="tts-status">
            {statusLine}
          </p>
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="tts-voice">Voice</Label>
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || tts.voices.length === 0}
            onClick={() => (speaking ? void stopSpeaking() : void previewVoice(tts.voiceId))}
            data-testid="tts-preview"
          >
            {speaking ? (
              <>
                <Square className="mr-1.5 h-3 w-3 fill-current" />
                Stop
              </>
            ) : (
              <>
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Listen
              </>
            )}
          </Button>
        </div>
        {tts.voices.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tts.engine === 'system'
              ? 'This system has no voice that 20x can use.'
              : 'Download a voice below to choose a speaker.'}
          </p>
        ) : (
          <select
            id="tts-voice"
            className="w-full rounded-md border border-border bg-input px-2 py-1.5 text-sm text-foreground"
            value={tts.voiceId}
            onChange={(e) => void setTtsVoice(e.target.value)}
            data-testid="tts-voice-select"
          >
            {tts.voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
                {voice.description ? ` — ${voice.description}` : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Downloading a better voice is a normal choice, not an advanced one,
          so the catalogue stays in view. */}
      <div className="space-y-3">
        <Label>Downloaded voices</Label>
        <p className="-mt-1 text-xs text-muted-foreground">
          Each voice is downloaded on request, checked against a SHA-256 value, and kept in the app data
          directory.
        </p>

        {tts.models.map((model) => (
          <div
            key={model.id}
            className={`rounded-lg border p-3 ${
              model.active && model.installed && tts.engine === 'local'
                ? 'border-primary/60 bg-primary/5'
                : 'border-border'
            }`}
            data-testid={`tts-model-${model.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{model.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{model.description}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatSize(model.sizeBytes)} to download, {formatSize(model.unpackedBytes)} on disk ·{' '}
                  {model.speakerCount} voices ·{' '}
                  <a
                    href={model.licenseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    {model.license}
                  </a>
                </p>
                {!model.downloadable && (
                  <p className="mt-1 text-xs text-yellow-500">
                    The checksum for this voice is not recorded yet.
                  </p>
                )}
                {model.error && <p className="mt-1 text-xs text-red-400">{model.error}</p>}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {model.installed ? (
                  <>
                    {!(model.active && tts.engine === 'local') && (
                      <Button
                        size="sm"
                        onClick={() => void selectTtsModel(model.id)}
                        data-testid={`tts-model-use-${model.id}`}
                      >
                        Use
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => void removeTtsModel(model.id)}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!model.downloadable || model.installing}
                    onClick={() => void installTtsModel(model.id)}
                    data-testid={`tts-model-download-${model.id}`}
                  >
                    {model.installing ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {model.installing ? `${Math.round(model.progress * 100)}%` : 'Download'}
                  </Button>
                )}
              </div>
            </div>

            {model.installing && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${Math.round(model.progress * 100)}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {advancedReady && (
        <AdvancedDisclosure
          label="Advanced options (text to speech)"
          defaultOpen={advanced}
          onOpenChange={rememberAdvanced}
          data-testid="tts-advanced"
        >
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium text-foreground">Status</p>
            <p className="mt-1 text-muted-foreground" data-testid="tts-status-advanced">
              {statusLine}
            </p>
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            <Label>Voice engine</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    id: 'system' as const,
                    title: 'This system',
                    detail: 'No download. It uses the voice the operating system already has.'
                  },
                  {
                    id: 'local' as const,
                    title: 'Downloaded voice',
                    detail: 'More natural. It needs the speech runtime and a model on disk.'
                  }
                ] satisfies Array<{ id: VoiceTtsEngineId; title: string; detail: string }>
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => void setTtsEngine(option.id)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    tts.engine === option.id
                      ? 'border-primary/60 bg-primary/5'
                      : 'border-border hover:border-primary/40'
                  }`}
                  data-testid={`tts-engine-${option.id}`}
                >
                  <p className="text-sm font-medium text-foreground">{option.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{option.detail}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <Label htmlFor="tts-speed">Reading speed</Label>
            <select
              id="tts-speed"
              className="rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground"
              value={tts.speed}
              onChange={(e) => void setTtsSpeed(Number(e.target.value))}
            >
              {VOICE_TTS_SPEED_CHOICES.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="tts-max-chars">Stop reading after</Label>
              <p className="text-xs text-muted-foreground">
                A long answer is cut at the end of a sentence. Use the speak button on the message to
                hear the rest.
              </p>
            </div>
            <select
              id="tts-max-chars"
              className="rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground"
              value={tts.maxChars}
              onChange={(e) => void setTtsMaxChars(Number(e.target.value))}
            >
              {VOICE_TTS_MAX_CHARS_CHOICES.map((chars) => (
                <option key={chars} value={chars}>
                  {chars} characters
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="space-y-0.5">
              <Label>Read only what you asked for by voice</Label>
              <p className="text-xs text-muted-foreground">
                Keep this on and 20x reads the answer to a spoken question only. Switch it off and it
                reads every agent answer, including one from a task running in the background.
              </p>
            </div>
            <Switch
              checked={tts.onlyVoiceTurns}
              onCheckedChange={(next) => void setTtsOnlyVoiceTurns(next)}
              data-testid="tts-only-voice-turns"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="space-y-0.5">
              <Label>Say the result of a command</Label>
              <p className="text-xs text-muted-foreground">Short lines such as “Task created.”</p>
            </div>
            <Switch
              checked={tts.speakActionResults}
              onCheckedChange={(next) => void setTtsSpeakActionResults(next)}
            />
          </div>
        </AdvancedDisclosure>
      )}
    </SettingsSection>
  )
}
