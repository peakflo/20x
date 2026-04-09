import { create } from 'zustand'
import { enterpriseApi } from '@/lib/ipc-client'

interface EnterpriseTenant {
  id: string
  name: string
}

interface EnterpriseCompany {
  id: string
  name: string
  isPrimary: boolean
}

interface EnterpriseState {
  // Auth state
  isAuthenticated: boolean
  isLoading: boolean
  isSyncing: boolean
  error: string | null

  // User info
  userEmail: string | null
  userId: string | null
  currentTenant: EnterpriseTenant | null
  availableTenants: EnterpriseCompany[] | null

  // Actions
  login: (email: string, password: string) => Promise<void>
  selectTenant: (tenantId: string) => Promise<void>
  logout: () => Promise<void>
  loadSession: () => Promise<void>
  clearError: () => void
  setSyncing: (syncing: boolean) => void
}

export const useEnterpriseStore = create<EnterpriseState>((set) => ({
  isAuthenticated: false,
  isLoading: false,
  isSyncing: false,
  error: null,
  userEmail: null,
  userId: null,
  currentTenant: null,
  availableTenants: null,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null })
    try {
      const result = await enterpriseApi.login(email, password)
      set({
        isLoading: false,
        userEmail: result.email,
        userId: result.userId,
        availableTenants: result.companies,
        // If user has exactly one company, auto-select it
        // Otherwise show the tenant selection UI
        isAuthenticated: false
      })

      // Auto-select if only one company
      if (result.companies.length === 1) {
        const tenant = result.companies[0]
        set({ isLoading: true })
        try {
          await enterpriseApi.selectTenant(tenant.id)
          // Show "Connected" immediately — sync runs in background
          set({
            isLoading: false,
            isAuthenticated: true,
            isSyncing: true,
            currentTenant: { id: tenant.id, name: tenant.name },
            availableTenants: result.companies
          })
        } catch (err) {
          set({
            isLoading: false,
            error: err instanceof Error ? err.message : 'Failed to select organization'
          })
        }
      }
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Sign in failed'
      })
    }
  },

  selectTenant: async (tenantId: string) => {
    set({ isLoading: true, error: null })
    try {
      const result = await enterpriseApi.selectTenant(tenantId)
      // Show "Connected" immediately — sync runs in background
      set({
        isLoading: false,
        isAuthenticated: true,
        isSyncing: true,
        currentTenant: result.tenant
      })
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to select organization'
      })
    }
  },

  logout: async () => {
    set({ isLoading: true, error: null })
    try {
      await enterpriseApi.logout()
    } catch {
      // Ignore errors — we clear state regardless
    }
    set({
      isLoading: false,
      isAuthenticated: false,
      isSyncing: false,
      userEmail: null,
      userId: null,
      currentTenant: null,
      availableTenants: null,
      error: null
    })
  },

  loadSession: async () => {
    set({ isLoading: true })
    try {
      const session = await enterpriseApi.getSession()
      set({
        isLoading: false,
        isAuthenticated: session.isAuthenticated,
        userEmail: session.userEmail,
        userId: session.userId,
        currentTenant: session.currentTenant
      })
    } catch {
      set({
        isLoading: false,
        isAuthenticated: false,
        userEmail: null,
        userId: null,
        currentTenant: null
      })
    }
  },

  clearError: () => set({ error: null }),

  setSyncing: (syncing: boolean) => set({ isSyncing: syncing })
}))
