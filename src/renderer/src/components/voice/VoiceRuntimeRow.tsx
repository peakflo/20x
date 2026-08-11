import { useEffect } from 'react'
import { Check, Download, Loader2, Mic, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { selectVoiceSetupComplete, useVoiceStore } from '@/stores/voice-store'

interface VoiceRuntimeRowProps {
  /** `compact` is the onboarding row. `full` is the settings section. */
  variant?: 'compact' | 'full'
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} kB`
}

/**
 * The optional install of the local speech runtime.
 *
 * Voice control is off until this runtime is present, and every voice control
 * in the app stays hidden until then. The install is never automatic: the user
 * sees the download size and asks for it.
 *
 * The same control is used in the onboarding dialog and in Voice settings, so
 * there is one behaviour to learn and one place to fix.
 */
export function VoiceRuntimeRow({ variant = 'full' }: VoiceRuntimeRowProps) {
  const available = useVoiceStore((s) => s.available)
  const runtime = useVoiceStore((s) => s.runtime)
  const models = useVoiceStore((s) => s.models)
  const complete = useVoiceStore(selectVoiceSetupComplete)
  const install = useVoiceStore((s) => s.install)
  const refreshRuntime = useVoiceStore((s) => s.refreshRuntime)
  const installRuntime = useVoiceStore((s) => s.installRuntime)
  const removeRuntime = useVoiceStore((s) => s.removeRuntime)

  const refresh = useVoiceStore((s) => s.refresh)

  useEffect(() => {
    void refreshRuntime()
    void refresh()
  }, [refreshRuntime, refresh])

  if (!available) return null

  const busy = install.running
  const compact = variant === 'compact'
  // One action downloads everything voice needs, so the size shown is the total.
  const pendingModelBytes = models.some((m) => m.installed)
    ? 0
    : (models[0]?.sizeBytes ?? 0)
  const totalBytes = (runtime.installed ? 0 : runtime.sizeBytes) + pendingModelBytes

  return (
    <div
      className={
        compact
          ? 'rounded-lg border border-border bg-muted/20 px-3 py-2'
          : 'rounded-lg border border-border p-3'
      }
      data-testid="voice-runtime-row"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`flex items-center gap-1.5 font-medium text-foreground ${compact ? 'text-xs' : 'text-sm'}`}>
            <Mic className={compact ? 'size-3.5' : 'size-4'} />
            Voice control
            <span className="font-normal text-muted-foreground">(optional)</span>
          </p>
          <p className={`mt-0.5 text-muted-foreground ${compact ? 'text-[11px]' : 'text-xs'}`}>
            {complete
              ? `Ready to use${runtime.version ? ` — runtime v${runtime.version}` : ''}. Switch it on below.`
              : runtime.installed
                ? `The speech runtime is installed. One more step downloads the English speech model (about ${formatSize(
                    pendingModelBytes
                  )}).`
                : `Dictate and run task commands by speech. This downloads the speech runtime and the English model, about ${formatSize(
                    totalBytes
                  )} in total, and only if you ask for it.`}
          </p>
          {install.error && (
            <p className="mt-1 text-[11px] text-red-400" data-testid="voice-runtime-error">
              {install.error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {complete ? (
            <>
              <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                <Check className="size-3" />
                Installed
              </span>
              {!compact && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void removeRuntime()}
                  title="Delete the speech runtime"
                >
                  <Trash2 className="mr-1.5 size-3.5" />
                  Remove
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant={compact ? 'ghost' : 'default'}
              disabled={busy}
              onClick={() => void installRuntime()}
              data-testid="voice-runtime-install"
            >
              {busy ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  {install.percent}%
                </>
              ) : (
                <>
                  <Download className="mr-1.5 size-3.5" />
                  {runtime.installed ? 'Finish setup' : 'Install'}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {busy && !compact && install.log && (
        <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-muted/40 p-2 text-[10px] leading-relaxed text-muted-foreground">
          {install.log.slice(-800)}
        </pre>
      )}
    </div>
  )
}
