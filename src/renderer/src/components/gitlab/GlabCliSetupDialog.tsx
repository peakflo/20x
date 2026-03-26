import { useState, useEffect } from 'react'
import { CheckCircle, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { useSettingsStore } from '@/stores/settings-store'

interface GlabCliSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}

export function GlabCliSetupDialog({ open, onOpenChange, onComplete }: GlabCliSetupDialogProps) {
  const { glabCliStatus, checkGlabCli, startGlabAuth } = useSettingsStore()
  const [isChecking, setIsChecking] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [deviceCode, setDeviceCode] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setIsChecking(true)
      setDeviceCode(null)
      checkGlabCli().finally(() => setIsChecking(false))
    }
  }, [open])

  useEffect(() => {
    return window.electronAPI.onGitlabDeviceCode((code) => {
      setDeviceCode(code)
    })
  }, [])

  const handleAuth = async () => {
    setIsAuthenticating(true)
    setDeviceCode(null)
    try {
      await startGlabAuth()
    } catch {
      // Re-check status even on error
      await checkGlabCli()
    } finally {
      setIsAuthenticating(false)
      setDeviceCode(null)
    }
  }

  const isInstalled = glabCliStatus?.installed ?? false
  const isAuthenticated = glabCliStatus?.authenticated ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>GitLab CLI Setup</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {isChecking ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Step 1: Install glab */}
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 h-5 w-5 rounded-full flex items-center justify-center shrink-0 ${isInstalled ? 'bg-green-500/20 text-green-400' : 'bg-muted text-muted-foreground'}`}>
                  {isInstalled ? <CheckCircle className="h-3.5 w-3.5" /> : <span className="text-xs font-medium">1</span>}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">Install GitLab CLI</p>
                  {!isInstalled && (
                    <div className="mt-2 space-y-2">
                      <div className="space-y-1">
                        {navigator.platform?.toLowerCase().includes('win') ? (
                          <code className="block text-xs bg-muted px-3 py-2 rounded">winget install GLab.GLab</code>
                        ) : navigator.platform?.toLowerCase().includes('linux') ? (
                          <>
                            <code className="block text-xs bg-muted px-3 py-2 rounded">brew install glab</code>
                            <code className="block text-xs bg-muted px-3 py-2 rounded">snap install glab</code>
                          </>
                        ) : (
                          <>
                            <code className="block text-xs bg-muted px-3 py-2 rounded">brew install glab</code>
                          </>
                        )}
                      </div>
                      <a
                        href="https://gitlab.com/gitlab-org/cli#installation"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        gitlab.com/gitlab-org/cli <ExternalLink className="h-3 w-3" />
                      </a>
                      <Button size="sm" variant="outline" onClick={() => { setIsChecking(true); checkGlabCli().finally(() => setIsChecking(false)) }}>
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
                  <p className="text-sm font-medium">Authenticate with GitLab</p>
                  {isInstalled && !isAuthenticated && (
                    <div className="mt-2 space-y-2">
                      {isAuthenticating && deviceCode ? (
                        <>
                          <p className="text-xs text-muted-foreground">Enter this code in your browser:</p>
                          <code className="block text-lg font-mono font-bold bg-muted px-3 py-2 rounded text-center">
                            {deviceCode}
                          </code>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Waiting for authorization...
                          </div>
                        </>
                      ) : (
                        <Button size="sm" onClick={handleAuth} disabled={isAuthenticating}>
                          {isAuthenticating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                          Authenticate with GitLab
                        </Button>
                      )}
                    </div>
                  )}
                  {isAuthenticated && glabCliStatus?.username && (
                    <p className="text-xs text-muted-foreground mt-1">Logged in as {glabCliStatus.username}</p>
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
