import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enterpriseApi } from '@/lib/ipc-client'
import { useEnterpriseStore, type EnterpriseSyncStats } from './enterprise-store'

// Mock the ipc-client so the store can be imported without Electron
vi.mock('@/lib/ipc-client', () => ({
  enterpriseApi: {
    apiRequest: vi.fn().mockResolvedValue({}),
    getSession: vi.fn().mockResolvedValue({ isAuthenticated: false }),
    login: vi.fn(),
    signupInBrowser: vi.fn(),
    selectTenant: vi.fn(),
    logout: vi.fn(),
    refreshToken: vi.fn(),
  },
  onTaskDeleted: vi.fn(() => vi.fn()),
}))

describe('useEnterpriseStore — sync stats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store to initial state
    useEnterpriseStore.setState({
      isAuthenticated: false,
      isLoading: false,
      isSyncing: false,
      error: null,
      userEmail: null,
      userId: null,
      currentTenant: null,
      availableTenants: null,
      lastSyncStats: null,
      lastSyncMs: null
    })
  })

  it('stores sync stats via setSyncResult', () => {
    const stats: EnterpriseSyncStats = {
      agents: { created: 1, updated: 2 },
      skills: { created: 3, updated: 4, pushed: 5 },
      mcpServers: { created: 0, updated: 1 },
      taskSources: { created: 0, updated: 0 },
      errors: []
    }

    useEnterpriseStore.getState().setSyncResult(stats, 1234)

    const state = useEnterpriseStore.getState()
    expect(state.lastSyncStats).toEqual(stats)
    expect(state.lastSyncMs).toBe(1234)
  })

  it('clears sync stats on setSyncResult(null, null)', () => {
    // Set some stats first
    useEnterpriseStore.getState().setSyncResult(
      {
        agents: { created: 1, updated: 0 },
        skills: { created: 2, updated: 0, pushed: 1 },
        mcpServers: { created: 0, updated: 0 },
        taskSources: { created: 0, updated: 0 },
        errors: []
      },
      500
    )

    // Clear them
    useEnterpriseStore.getState().setSyncResult(null, null)

    const state = useEnterpriseStore.getState()
    expect(state.lastSyncStats).toBeNull()
    expect(state.lastSyncMs).toBeNull()
  })

  it('clears sync stats on logout', async () => {
    // Set some stats
    useEnterpriseStore.getState().setSyncResult(
      {
        agents: { created: 1, updated: 0 },
        skills: { created: 2, updated: 0, pushed: 1 },
        mcpServers: { created: 0, updated: 0 },
        taskSources: { created: 0, updated: 0 },
        errors: []
      },
      800
    )

    await useEnterpriseStore.getState().logout()

    const state = useEnterpriseStore.getState()
    expect(state.lastSyncStats).toBeNull()
    expect(state.lastSyncMs).toBeNull()
    expect(state.isAuthenticated).toBe(false)
  })

  it('initializes with null sync stats', () => {
    const state = useEnterpriseStore.getState()
    expect(state.lastSyncStats).toBeNull()
    expect(state.lastSyncMs).toBeNull()
  })

  it('preserves sync stats across other state changes', () => {
    const stats: EnterpriseSyncStats = {
      agents: { created: 0, updated: 0 },
      skills: { created: 5, updated: 2, pushed: 3 },
      mcpServers: { created: 1, updated: 0 },
      taskSources: { created: 1, updated: 0 },
      errors: ['Some error']
    }

    useEnterpriseStore.getState().setSyncResult(stats, 999)
    useEnterpriseStore.getState().setSyncing(true)
    useEnterpriseStore.getState().setSyncing(false)

    const state = useEnterpriseStore.getState()
    expect(state.lastSyncStats).toEqual(stats)
    expect(state.lastSyncMs).toBe(999)
  })

  it('passes the AI subscription preference to browser signup', async () => {
    vi.mocked(enterpriseApi.signupInBrowser).mockResolvedValue({
      userId: 'user-1',
      email: 'new@example.com',
      companies: []
    })

    await useEnterpriseStore.getState().signupInBrowser('register', {
      includeAiSubscription: true
    })

    expect(enterpriseApi.signupInBrowser).toHaveBeenCalledWith('register', {
      includeAiSubscription: true
    })
  })
})
