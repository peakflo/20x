import { AppLayout } from '@/components/layout/AppLayout'
import { useEffect, useState } from 'react'
import { CursorCliSetupDialog } from '@/components/agents/CursorCliSetupDialog'
import { identifyAnalyticsUser, resetAnalyticsUser, setAnalyticsEnterpriseEmail } from '@/lib/analytics'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useUserStore } from '@/stores/user-store'

interface CursorRetryRequest {
  taskId: string
  taskTitle: string
  operation: 'start' | 'resume'
  retry: () => Promise<string>
}

export default function App() {
  const [cursorRetries, setCursorRetries] = useState<CursorRetryRequest[]>([])
  const activeCursorRetry = cursorRetries[0]
  useEffect(() => {
    const onMissing = (event: Event) => {
      const request = (event as CustomEvent<CursorRetryRequest>).detail
      setCursorRetries((pending) => pending.some((item) => item.taskId === request.taskId && item.operation === request.operation)
        ? pending
        : [...pending, request])
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
        key={activeCursorRetry ? `${activeCursorRetry.taskId}:${activeCursorRetry.operation}` : 'cursor-cli'}
        open={!!activeCursorRetry}
        taskTitle={activeCursorRetry?.taskTitle || ''}
        onOpenChange={(open) => {
          if (!open) setCursorRetries((pending) => pending.filter((item) => item !== activeCursorRetry))
        }}
        onRetry={async () => {
          await activeCursorRetry?.retry()
          setCursorRetries((pending) => pending.filter((item) => item !== activeCursorRetry))
        }}
      />
    </>
  )
}
