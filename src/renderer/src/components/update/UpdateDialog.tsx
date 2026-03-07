import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Markdown } from '@/components/ui/Markdown'
import { useUpdateStore } from '@/stores/update-store'
import { Download, RotateCw, Loader2, ExternalLink } from 'lucide-react'

interface UpdateDialogProps {
  open: boolean
  onClose: () => void
}

export function UpdateDialog({ open, onClose }: UpdateDialogProps) {
  const {
    updateAvailable,
    currentVersion,
    isDownloading,
    downloadProgress,
    isReadyToInstall,
    error,
    downloadUpdate,
    installUpdate
  } = useUpdateStore()

  const handleInstall = async () => {
    console.log('[UpdateDialog] Install button clicked')
    console.log('[UpdateDialog] isReadyToInstall:', isReadyToInstall)
    try {
      console.log('[UpdateDialog] Calling installUpdate...')
      await installUpdate()
      console.log('[UpdateDialog] installUpdate resolved')
    } catch (err) {
      console.error('[UpdateDialog] installUpdate error:', err)
    }
  }

  if (!updateAvailable) return null

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Update Available</DialogTitle>
          <DialogDescription>
            A new version of 20x is available
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            {/* Version comparison */}
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">Current:</span>
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                v{currentVersion ?? '?'}
              </code>
              <span className="text-muted-foreground">&rarr;</span>
              <code className="bg-primary/10 text-primary px-1.5 py-0.5 rounded text-xs font-semibold">
                v{updateAvailable.version}
              </code>
            </div>

            {/* Release notes */}
            {updateAvailable.releaseNotes && (
              <div className="border border-border rounded-lg p-4 max-h-64 overflow-y-auto">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  What&apos;s New
                </h4>
                <Markdown size="xs">
                  {updateAvailable.releaseNotes}
                </Markdown>
              </div>
            )}

            {/* Link to full release page */}
            <a
              href={`https://github.com/peakflo/20x/releases/tag/v${updateAvailable.version}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              onClick={(e) => {
                e.preventDefault()
                window.electronAPI.shell.openExternal(`https://github.com/peakflo/20x/releases/tag/v${updateAvailable.version}`)
              }}
            >
              <ExternalLink className="h-3 w-3" />
              View full release on GitHub
            </a>

            {/* Download progress */}
            {isDownloading && downloadProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Downloading update...</span>
                  <span>{Math.round(downloadProgress.percent)}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {isDownloading && !downloadProgress && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting download...
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2">
              {isReadyToInstall ? (
                <Button type="button" onClick={handleInstall} className="flex-1">
                  <RotateCw className="h-4 w-4 mr-2" />
                  Install &amp; Restart
                </Button>
              ) : (
                <Button
                  onClick={downloadUpdate}
                  disabled={isDownloading}
                  className="flex-1"
                >
                  {isDownloading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  {isDownloading ? 'Downloading...' : 'Download Update'}
                </Button>
              )}
              <Button variant="outline" onClick={onClose}>
                Later
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
