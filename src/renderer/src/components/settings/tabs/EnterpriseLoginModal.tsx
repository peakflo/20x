import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogDescription
} from '@/components/ui/Dialog'
import { Label } from '@/components/ui/Label'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useEnterpriseStore } from '@/stores/enterprise-store'

interface EnterpriseLoginModalProps {
  open: boolean
  onClose: () => void
}

export function EnterpriseLoginModal({ open, onClose }: EnterpriseLoginModalProps) {
  const {
    isLoading,
    error,
    userEmail,
    availableTenants,
    login,
    selectTenant,
    clearError
  } = useEnterpriseStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // After login, we may have tenants to select — show that step in the same modal
  const showTenantSelection = availableTenants && availableTenants.length > 0

  const handleLogin = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    await login(email.trim(), password)
    setPassword('') // Never keep password in memory after submission
  }, [email, password, login])

  const handleSelectTenant = useCallback(async (tenantId: string) => {
    // Close modal immediately — sync runs in the background via IPC
    onClose()
    await selectTenant(tenantId)
  }, [selectTenant, onClose])

  const handleClose = useCallback(() => {
    // If we're in the middle of tenant selection, clear partial state
    if (showTenantSelection) {
      useEnterpriseStore.setState({
        availableTenants: null,
        userEmail: null,
        userId: null
      })
    }
    setEmail('')
    setPassword('')
    clearError()
    onClose()
  }, [showTenantSelection, clearError, onClose])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {showTenantSelection ? 'Select Organization' : 'Sign in to 20x Cloud'}
          </DialogTitle>
          <DialogDescription>
            {showTenantSelection
              ? `Signed in as ${userEmail}. Choose an organization to connect.`
              : 'Enter your 20x Cloud credentials to connect.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {showTenantSelection ? (
            // ── Tenant selection step ──────────────────────────
            <div className="space-y-3">
              {error && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}

              <div className="space-y-2">
                {availableTenants.map((company) => (
                  <button
                    key={company.id}
                    onClick={() => handleSelectTenant(company.id)}
                    disabled={isLoading}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-md border border-border bg-background hover:bg-accent hover:border-accent-foreground/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center">
                        <span className="text-sm font-semibold text-primary">
                          {company.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-foreground">{company.name}</span>
                    </div>
                    {company.isPrimary && (
                      <span className="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">
                        Primary
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClose}
                  disabled={isLoading}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            // ── Login form step ───────────────────────────────
            <form onSubmit={handleLogin} className="space-y-4">
              {error && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
                  <p className="text-sm text-destructive">{error}</p>
                  <button
                    type="button"
                    onClick={clearError}
                    className="text-xs text-destructive/70 hover:text-destructive mt-1 underline"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="enterprise-email">Email</Label>
                <Input
                  id="enterprise-email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isLoading}
                  required
                  autoComplete="email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="enterprise-password">Password</Label>
                <Input
                  id="enterprise-password"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                  required
                  autoComplete="current-password"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  type="submit"
                  disabled={isLoading || !email.trim() || !password}
                  className="flex-1"
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Signing in...
                    </span>
                  ) : (
                    'Sign in'
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleClose}
                  disabled={isLoading}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
