import { useEffect, useState } from 'react'
import { Download, FolderOpen, Loader2, Mic, Trash2 } from 'lucide-react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { settingsApi, voiceApi } from '@/lib/ipc-client'
import { useVoiceStore } from '@/stores/voice-store'
import { VoiceRuntimeRow } from '@/components/voice/VoiceRuntimeRow'
import { VOICE_DEFAULT_SHORTCUT, VOICE_SETTING_KEYS } from '@shared/voice'

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} kB`
}

/**
 * Voice control settings (design §5.9 and §5.10).
 *
 * Everything with a privacy or a disk cost is explicit here: the microphone
 * request, the model download with its size and licence, the custom model
 * directory, and the controls that delete every downloaded model.
 */
export function VoiceSettings() {
  const available = useVoiceStore((s) => s.available)
  const enabled = useVoiceStore((s) => s.enabled)
  const runtime = useVoiceStore((s) => s.runtime)
  const engine = useVoiceStore((s) => s.engine)
  const models = useVoiceStore((s) => s.models)
  const permission = useVoiceStore((s) => s.permission)
  const shortcut = useVoiceStore((s) => s.shortcut)
  const initialize = useVoiceStore((s) => s.initialize)
  const setEnabled = useVoiceStore((s) => s.setEnabled)
  const installModel = useVoiceStore((s) => s.installModel)
  const removeModel = useVoiceStore((s) => s.removeModel)
  const removeAllModels = useVoiceStore((s) => s.removeAllModels)
  const setCustomModelDir = useVoiceStore((s) => s.setCustomModelDir)
  const setShortcut = useVoiceStore((s) => s.setShortcut)

  const [quickCreate, setQuickCreate] = useState(false)
  const [customDir, setCustomDir] = useState('')
  const [shortcutDraft, setShortcutDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void initialize()
    void settingsApi.get(VOICE_SETTING_KEYS.quickCreate).then((v) => setQuickCreate(v === 'true'))
    void settingsApi.get(VOICE_SETTING_KEYS.customModelDir).then((v) => setCustomDir(v ?? ''))
  }, [initialize])

  useEffect(() => setShortcutDraft(shortcut || VOICE_DEFAULT_SHORTCUT), [shortcut])

  if (!available) {
    return (
      <SettingsSection title="Voice control" description="Voice control is not available in this build.">
        <p className="text-sm text-muted-foreground">Update the desktop app to use voice control.</p>
      </SettingsSection>
    )
  }

  const pickDir = async (): Promise<void> => {
    const { dir } = await voiceApi.pickModelDir()
    if (!dir) return
    setCustomDir(dir)
    await setCustomModelDir(dir)
  }

  return (
    <>
      <SettingsSection
        title="Voice control"
        description="Speech is recognised on this computer. No audio is stored, and no audio leaves the device."
      >
        <VoiceRuntimeRow />

        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2">
              <Mic className="h-4 w-4" />
              Enable voice control
            </Label>
            <p className="text-xs text-muted-foreground">
              {runtime.installed
                ? '20x asks for the microphone the first time you switch this on.'
                : 'Install the local speech runtime above first.'}
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={!runtime.installed}
            onCheckedChange={(next) => void setEnabled(next)}
          />
        </div>

        <div className="rounded-lg border border-border p-3 text-sm">
          <p className="font-medium text-foreground">Status</p>
          <p className="mt-1 text-muted-foreground">
            {engine.state === 'ready'
              ? `Ready — ${engine.engine}, model ${engine.modelId}.`
              : engine.state === 'loading'
                ? 'The speech model is loading.'
                : engine.state === 'engine_missing'
                  ? engine.message
                  : engine.state === 'model_missing'
                    ? engine.message
                    : engine.message}
          </p>
          <p className="mt-1 text-muted-foreground">
            Microphone permission: <span className="text-foreground">{permission}</span>
          </p>
          {permission === 'denied' && (
            <p className="mt-1 text-xs text-red-400">
              Allow the microphone for 20x in the system privacy settings, then restart the app.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="space-y-0.5">
            <Label>Create a task without a confirmation</Label>
            <p className="text-xs text-muted-foreground">
              Approve, reject, and assign always keep their confirmation card.
            </p>
          </div>
          <Switch
            checked={quickCreate}
            onCheckedChange={(next) => {
              setQuickCreate(next)
              void settingsApi.set(VOICE_SETTING_KEYS.quickCreate, next ? 'true' : 'false')
            }}
          />
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <Label htmlFor="voice-shortcut">Global shortcut</Label>
          <p className="text-xs text-muted-foreground">
            This shortcut starts and stops a command turn. Press-and-hold works inside the app window.
          </p>
          <div className="flex gap-2">
            <Input
              id="voice-shortcut"
              value={shortcutDraft}
              onChange={(e) => setShortcutDraft(e.target.value)}
              placeholder={VOICE_DEFAULT_SHORTCUT}
            />
            <Button variant="outline" onClick={() => void setShortcut(shortcutDraft)}>
              Save
            </Button>
          </div>
        </div>
      </SettingsSection>

      {runtime.installed && (
      <SettingsSection
        title="Speech models"
        description="Models are downloaded on request, checked against a SHA-256 value, and kept in the app data directory."
      >
        {models.length === 0 && <p className="text-sm text-muted-foreground">No model is listed.</p>}

        {models.map((model) => (
          <div key={model.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{model.label}</p>
                <p className="text-xs text-muted-foreground">
                  {formatSize(model.sizeBytes)} · {model.languages.join(', ')} · {model.license}
                </p>
                {!model.downloadable && (
                  <p className="mt-1 text-xs text-yellow-500">
                    The checksum for this model is not recorded yet. Use a model directory below.
                  </p>
                )}
                {model.error && <p className="mt-1 text-xs text-red-400">{model.error}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                {model.installed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void removeModel(model.id)}
                    title="Delete this model"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Delete
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!model.downloadable || model.installing}
                    onClick={() => void installModel(model.id)}
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
          </div>
        ))}

        <div className="space-y-2 rounded-lg border border-border p-3">
          <Label htmlFor="voice-model-dir">Model directory installed by hand</Label>
          <p className="text-xs text-muted-foreground">
            Point 20x at a directory that holds an encoder, a decoder, a joiner and a tokens file.
          </p>
          <div className="flex gap-2">
            <Input
              id="voice-model-dir"
              value={customDir}
              onChange={(e) => setCustomDir(e.target.value)}
              placeholder="/path/to/sherpa-onnx-streaming-model"
            />
            <Button variant="outline" onClick={() => void pickDir()}>
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              Browse
            </Button>
            <Button variant="outline" onClick={() => void setCustomModelDir(customDir)}>
              Use
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="space-y-0.5">
            <Label>Delete every downloaded model</Label>
            <p className="text-xs text-muted-foreground">This gives the disk space back immediately.</p>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await removeAllModels()
              setBusy(false)
            }}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
            Delete all
          </Button>
        </div>
      </SettingsSection>
      )}
    </>
  )
}
