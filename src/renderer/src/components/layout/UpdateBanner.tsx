import { useEffect } from 'react'
import { useUpdateStore } from '@/stores/update-store'
import { Button } from '@/components/ui/Button'
import { Download, RefreshCw, RotateCcw, X, CheckCircle2, AlertCircle } from 'lucide-react'

export function UpdateBanner() {
  const {
    status,
    version,
    progress,
    error,
    dismissed,
    dismiss,
    downloadUpdate,
    installUpdate,
    initListener
  } = useUpdateStore()

  useEffect(() => {
    const cleanup = initListener()
    return cleanup
  }, [initListener])

  // Don't render if idle, checking, not-available, or dismissed
  if (status === 'idle' || status === 'checking' || status === 'not-available' || dismissed) {
    return null
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card/50 text-sm">
      {status === 'available' && (
        <>
          <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
          <span className="flex-1 text-foreground">
            Version <span className="font-medium">{version}</span> is available
          </span>
          <Button
            variant="default"
            size="sm"
            onClick={downloadUpdate}
            className="h-7 px-3 text-xs"
          >
            <Download className="h-3 w-3 mr-1" />
            Download
          </Button>
          <button
            onClick={dismiss}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}

      {status === 'downloading' && (
        <>
          <RefreshCw className="h-4 w-4 text-primary flex-shrink-0 animate-spin" />
          <span className="text-foreground flex-shrink-0">Downloading update...</span>
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress?.percent ?? 0}%` }}
            />
          </div>
          <span className="text-muted-foreground text-xs flex-shrink-0">
            {Math.round(progress?.percent ?? 0)}%
          </span>
        </>
      )}

      {status === 'downloaded' && (
        <>
          <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
          <span className="flex-1 text-foreground">
            Update ready — restart to apply{version ? ` v${version}` : ''}
          </span>
          <Button
            variant="default"
            size="sm"
            onClick={installUpdate}
            className="h-7 px-3 text-xs"
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            Restart
          </Button>
          <button
            onClick={dismiss}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}

      {status === 'error' && (
        <>
          <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />
          <span className="flex-1 text-foreground truncate">
            Update error: {error || 'Unknown error'}
          </span>
          <button
            onClick={dismiss}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  )
}
