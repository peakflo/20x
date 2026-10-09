import { useEffect, useState } from 'react'
import { ExternalLink, Loader2, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SettingsSection } from '../SettingsSection'
import { cursorAuthApi } from '@/lib/ipc-client'
import type { CursorAuthStatus } from '@shared/cursor-auth'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Settings → Agents: Cursor's SDK sign-in status (the subscription/browser
 * login this adapter manages). API-key auth is configured per agent in the
 * agent form and isn't shown here — this card is only the shared login.
 */
export function CursorSettingsCard() {
  const [status, setStatus] = useState<CursorAuthStatus | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setLoadingStatus(true)
    try {
      setStatus(await cursorAuthApi.status())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoadingStatus(false)
    }
  }

  useEffect(() => {
    void refresh()
    return cursorAuthApi.onLoginComplete((event) => {
      setPendingUrl(null)
      if (!event.success) setError(event.error)
      void refresh()
    })
  }, [])

  const startSignIn = async (): Promise<void> => {
    setError(null)
    setStarting(true)
    try {
      const { url } = await cursorAuthApi.startBrowserLogin()
      setPendingUrl(url)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  const cancelSignIn = async (): Promise<void> => {
    await cursorAuthApi.cancelBrowserLogin()
    setPendingUrl(null)
  }

  const signOut = async (): Promise<void> => {
    setError(null)
    try {
      await cursorAuthApi.logout()
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <SettingsSection
      title="Cursor"
      description="Sign-in status for Cursor's SDK (subscription login). An API key, when set on a Cursor agent, takes priority over this."
    >
      <div className="space-y-3">
        {loadingStatus ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Checking sign-in status…
          </p>
        ) : status?.authenticated ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Signed in</p>
              {status.email && <p className="text-xs text-muted-foreground truncate">{status.email}</p>}
            </div>
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              {status?.reason === 'Not signed in' || !status?.reason ? 'Not signed in to Cursor.' : status.reason}
            </p>
            {pendingUrl ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Finish signing in at this URL. It opens in your browser only after you confirm.
                </p>
                <code className="block rounded bg-muted px-2 py-1 text-[11px] break-all">{pendingUrl}</code>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => window.open(pendingUrl, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open in browser
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void cancelSignIn()}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" onClick={() => void startSignIn()} disabled={starting}>
                {starting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Sign in with browser
              </Button>
            )}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </SettingsSection>
  )
}
