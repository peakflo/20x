import { AppLayout } from '@/components/layout/AppLayout'
import { useEffect, useState } from 'react'
import { CursorCliSetupDialog } from '@/components/agents/CursorCliSetupDialog'
import { identifyAnalyticsUser, resetAnalyticsUser, setAnalyticsEnterpriseEmail } from '@/lib/analytics'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useUserStore } from '@/stores/user-store'

export default function App() {
  const [cursorRetry, setCursorRetry] = useState<(() => Promise<string>) | null>(null)
  useEffect(() => {
    const onMissing = (event: Event) => {
      const retry = (event as CustomEvent<{ retry: () => Promise<string> }>).detail.retry
      setCursorRetry(() => retry)
    }
    window.addEventListener('cursor-cli-missing', onMissing)
    return () => window.removeEventListener('cursor-cli-missing', onMissing)
  }, [])
  const isAuthenticated = useEnterpriseStore((s) => s.isAuthenticated)
  const userId = useEnterpriseStore((s) => s.userId)
  const userEmail = useEnterpriseStore((s) => s.userEmail)
  const currentTenant = useEnterpriseStore((s) => s.currentTenant)
  const currentUserEmail = useUserStore((s) => s.currentUserEmail)

  useEffect(() => {
    setAnalyticsEnterpriseEmail(userEmail || null)
    const distinctId = userId || userEmail || currentUserEmail
    if (distinctId) {
      identifyAnalyticsUser(distinctId, {
        user_id: userId || undefined,
        email: userEmail || currentUserEmail || undefined,
        tenant_id: currentTenant?.id,
        tenant_name: currentTenant?.name,
        is_enterprise_authenticated: isAuthenticated
      })
    } else if (!isAuthenticated) {
      resetAnalyticsUser()
    }
  }, [isAuthenticated, userId, userEmail, currentUserEmail, currentTenant?.id, currentTenant?.name])

  return (
    <>
      <AppLayout />
      <CursorCliSetupDialog
        open={!!cursorRetry}
        onOpenChange={(open) => { if (!open) setCursorRetry(null) }}
        onRetry={async () => { await cursorRetry?.(); setCursorRetry(null) }}
      />
    </>
  )
}
