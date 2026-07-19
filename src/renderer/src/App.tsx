import { AppLayout } from '@/components/layout/AppLayout'
import { useEffect } from 'react'
import { identifyAnalyticsUser, resetAnalyticsUser } from '@/lib/analytics'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useUserStore } from '@/stores/user-store'

export default function App() {
  const isAuthenticated = useEnterpriseStore((s) => s.isAuthenticated)
  const userId = useEnterpriseStore((s) => s.userId)
  const userEmail = useEnterpriseStore((s) => s.userEmail)
  const currentTenant = useEnterpriseStore((s) => s.currentTenant)
  const currentUserEmail = useUserStore((s) => s.currentUserEmail)

  useEffect(() => {
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

  return <AppLayout />
}
