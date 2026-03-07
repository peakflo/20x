import { useState, useEffect, useCallback } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useEnterpriseStore } from '@/stores/enterprise-store'

export function EnterpriseSettings() {
  const {
    isAuthenticated,
    isLoading,
    error,
    userEmail,
    currentTenant,
    availableTenants,
    login,
    selectTenant,
    logout,
    loadSession,
    clearError
  } = useEnterpriseStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    loadSession()
  }, [loadSession])

  const handleLogin = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    await login(email.trim(), password)
    setPassword('') // Never keep password in memory after submission
  }, [email, password, login])

  const handleSelectTenant = useCallback(async (tenantId: string) => {
    await selectTenant(tenantId)
  }, [selectTenant])

  const handleLogout = useCallback(async () => {
    await logout()
    setEmail('')
    setPassword('')
  }, [logout])

  const handleSwitchOrg = useCallback(() => {
    // Go back to tenant selection by clearing current tenant
    // but keep authenticated state with available tenants
    useEnterpriseStore.setState({
      isAuthenticated: false,
      currentTenant: null
    })
    // Re-trigger login to refresh available tenants
    loadSession()
  }, [loadSession])

  // ── Logged-in view ─────────────────────────────────────────────
  if (isAuthenticated && currentTenant) {
    return (
      <SettingsSection
        title="20x Cloud"
        description="Connected to your organization's 20x Cloud"
      >
        <div className="space-y-4">
          {/* Connected status */}
          <div className="flex items-center gap-2 py-2">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-sm font-medium text-foreground">Connected</span>
          </div>

          {/* User email */}
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div className="space-y-0.5">
              <Label>Email</Label>
              <p className="text-xs text-muted-foreground">
                Signed in account
              </p>
            </div>
            <span className="text-sm text-foreground font-mono">
              {userEmail}
            </span>
          </div>

          {/* Current organization */}
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div className="space-y-0.5">
              <Label>Organization</Label>
              <p className="text-xs text-muted-foreground">
                Currently active organization
              </p>
            </div>
            <span className="text-sm text-foreground font-medium">
              {currentTenant.name}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSwitchOrg}
              disabled={isLoading}
            >
              Switch organization
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleLogout}
              disabled={isLoading}
            >
              Sign out
            </Button>
          </div>
        </div>
      </SettingsSection>
    )
  }

  // ── Tenant selection view ──────────────────────────────────────
  if (availableTenants && availableTenants.length > 0 && !isAuthenticated) {
    return (
      <SettingsSection
        title="20x Cloud"
        description="Select an organization to connect to"
      >
        <div className="space-y-3">
          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <p className="text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{userEmail}</span>
          </p>

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

          <div className="pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              disabled={isLoading}
            >
              Cancel
            </Button>
          </div>
        </div>
      </SettingsSection>
    )
  }

  // ── Login view ─────────────────────────────────────────────────
  return (
    <SettingsSection
      title="20x Cloud"
      description="Connect to your organization's 20x Cloud to access enterprise features"
    >
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

        <Button
          type="submit"
          disabled={isLoading || !email.trim() || !password}
          className="w-full"
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
            'Sign in to 20x Cloud'
          )}
        </Button>
      </form>
    </SettingsSection>
  )
}
