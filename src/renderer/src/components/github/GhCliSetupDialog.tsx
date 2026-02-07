import { useState, useEffect } from 'react'
import { CheckCircle, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { useSettingsStore } from '@/stores/settings-store'

interface GhCliSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

export function GhCliSetupDialog({ open, onOpenChange, onComplete }: GhCliSetupDialogProps) {
  const { ghCliStatus, checkGhCli, startGhAuth } = useSettingsStore()
  const [isChecking, setIsChecking] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)

  useEffect(() => {
    if (open) {
      setIsChecking(true)
      checkGhCli().finally(() => setIsChecking(false))
    }
  }, [open])

  const handleAuth = async () => {
    setIsAuthenticating(true)
    try {
      await startGhAuth()
    } catch {
      // Re-check status even on error
      await checkGhCli()
    } finally {
      setIsAuthenticating(false)
    }
  }

  const isInstalled = ghCliStatus?.installed ?? false
  const isAuthenticated = ghCliStatus?.authenticated ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>GitHub CLI Setup</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {isChecking ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Step 1: Install gh */}
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 h-5 w-5 rounded-full flex items-center justify-center shrink-0 ${isInstalled ? 'bg-green-500/20 text-green-400' : 'bg-muted text-muted-foreground'}`}>
                  {isInstalled ? <CheckCircle className="h-3.5 w-3.5" /> : <span className="text-xs font-medium">1</span>}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">Install GitHub CLI</p>
                  {!isInstalled && (
                    <div className="mt-2 space-y-2">
                      <code className="block text-xs bg-muted px-3 py-2 rounded">brew install gh</code>
                      <a
                        href="https://cli.github.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        cli.github.com <ExternalLink className="h-3 w-3" />
                      </a>
                      <Button size="sm" variant="outline" onClick={() => { setIsChecking(true); checkGhCli().finally(() => setIsChecking(false)) }}>
                        Re-check
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Step 2: Authenticate */}
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 h-5 w-5 rounded-full flex items-center justify-center shrink-0 ${isAuthenticated ? 'bg-green-500/20 text-green-400' : 'bg-muted text-muted-foreground'}`}>
                  {isAuthenticated ? <CheckCircle className="h-3.5 w-3.5" /> : <span className="text-xs font-medium">2</span>}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">Authenticate with GitHub</p>
                  {isInstalled && !isAuthenticated && (
                    <div className="mt-2">
                      <Button size="sm" onClick={handleAuth} disabled={isAuthenticating}>
                        {isAuthenticating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                        Authenticate with GitHub
                      </Button>
                    </div>
                  )}
                  {isAuthenticated && ghCliStatus?.username && (
                    <p className="text-xs text-muted-foreground mt-1">Logged in as {ghCliStatus.username}</p>
                  )}
                </div>
              </div>

              {/* Continue button */}
              {isAuthenticated && (
                <div className="pt-2">
                  <Button className="w-full" onClick={onComplete}>Continue</Button>
                </div>
              )}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
