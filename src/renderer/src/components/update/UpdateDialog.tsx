import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { updaterApi } from '@/lib/ipc-client'
import { Download, RotateCw, Loader2, ExternalLink, Check } from 'lucide-react'

interface UpdateDialogProps {
  open: boolean
  onClose: () => void
}

interface UpdateState {
  status: string
  version: string | null
  currentVersion: string | null
  releaseNotes: string
  releaseDate: string
  percent: number
  error: string | null
}

export function UpdateDialog({ open, onClose }: UpdateDialogProps) {
  const [state, setState] = useState<UpdateState>({
    status: 'idle',
    version: null,
    currentVersion: null,
    releaseNotes: '',
    releaseDate: '',
    percent: 0,
    error: null
  })

  // Load current version on mount
  useEffect(() => {
    updaterApi.getVersion().then((v) => {
      setState((s) => ({ ...s, currentVersion: v }))
    })
  }, [])

  // Subscribe to updater status events
  useEffect(() => {
    const cleanup = updaterApi.onStatus((data) => {
      setState((prev) => ({
        ...prev,
        status: data.status,
        version: data.version ?? prev.version,
        currentVersion: data.currentVersion ?? prev.currentVersion,
        releaseNotes: data.releaseNotes ?? prev.releaseNotes,
        releaseDate: data.releaseDate ?? prev.releaseDate,
        percent: data.percent ?? prev.percent,
        error: data.error ?? null
      }))
    })
    return cleanup
  }, [])

  // When opened from menu and no update known yet, trigger a check
  useEffect(() => {
    if (open && state.status === 'idle') {
      setState((s) => ({ ...s, status: 'checking', error: null }))
      updaterApi.check().then((result) => {
        // In dev mode (or if check fails synchronously), the main process
        // won't fire updater:status events — handle the response directly.
        if (result && !result.success) {
          setState((s) => s.status === 'checking'
            ? { ...s, status: 'error', error: result.error ?? 'Update check failed' }
            : s
          )
        }
      })
    }
  }, [open])

  const handleDownload = async () => {
    await updaterApi.download()
  }

  const handleInstall = () => {
    updaterApi.install()
  }

  const hasUpdate = state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded'

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{hasUpdate ? 'Update Available' : 'Software Update'}</DialogTitle>
          <DialogDescription>
            {state.status === 'checking'
              ? 'Checking for updates\u2026'
              : state.status === 'up-to-date'
                ? 'You\'re up to date!'
                : hasUpdate
                  ? 'A new version of 20x is available'
                  : 'Check for 20x updates'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            {/* Version comparison */}
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">Current:</span>
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                v{state.currentVersion ?? '?'}
              </code>
              {state.version && (
                <>
                  <span className="text-muted-foreground">&rarr;</span>
                  <code className="bg-primary/10 text-primary px-1.5 py-0.5 rounded text-xs font-semibold">
                    v{state.version}
                  </code>
                </>
              )}
            </div>

            {/* Checking spinner */}
            {state.status === 'checking' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking for updates...
              </div>
            )}

            {/* Up to date */}
            {state.status === 'up-to-date' && (
              <div className="text-sm text-green-400 flex items-center gap-1.5">
                <Check className="h-4 w-4" />
                20x is up to date. You&apos;re running the latest version.
              </div>
            )}

            {/* Release notes (may be HTML from GitHub or markdown) */}
            {hasUpdate && state.releaseNotes && (
              <div className="border border-border rounded-lg p-4 max-h-64 overflow-y-auto">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  What&apos;s New
                </h4>
                <div
                  className="text-xs text-foreground prose prose-invert prose-xs max-w-none [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-4 [&_li]:my-0.5"
                  dangerouslySetInnerHTML={{ __html: state.releaseNotes }}
                />
              </div>
            )}

            {/* Link to full release page */}
            {hasUpdate && state.version && (
              <a
                href={`https://github.com/peakflo/20x/releases/tag/v${state.version}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                onClick={(e) => {
                  e.preventDefault()
                  window.electronAPI?.shell?.openExternal(`https://github.com/peakflo/20x/releases/tag/v${state.version}`)
                }}
              >
                <ExternalLink className="h-3 w-3" />
                View full release on GitHub
              </a>
            )}

            {/* Download progress */}
            {state.status === 'downloading' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Downloading update...</span>
                  <span>{state.percent}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${state.percent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Error message */}
            {state.error && (
              <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                {state.error}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2">
              {state.status === 'downloaded' ? (
                <Button onClick={handleInstall} className="flex-1">
                  <RotateCw className="h-4 w-4 mr-2" />
                  Install &amp; Restart
                </Button>
              ) : state.status === 'available' ? (
                <Button onClick={handleDownload} className="flex-1">
                  <Download className="h-4 w-4 mr-2" />
                  Download Update
                </Button>
              ) : state.status === 'downloading' ? (
                <Button disabled className="flex-1">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Downloading...
                </Button>
              ) : null}
              <Button variant="outline" onClick={onClose}>
                {hasUpdate ? 'Later' : 'Close'}
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
