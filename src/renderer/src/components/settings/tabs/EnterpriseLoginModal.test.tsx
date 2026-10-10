import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { enterpriseApi } from '@/lib/ipc-client'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { EnterpriseLoginModal } from './EnterpriseLoginModal'

vi.mock('@/lib/ipc-client', () => ({
  enterpriseApi: {
    apiRequest: vi.fn().mockResolvedValue({}),
    getSession: vi.fn().mockResolvedValue({ isAuthenticated: false }),
    login: vi.fn(),
    signupInBrowser: vi.fn(),
    selectTenant: vi.fn(),
    logout: vi.fn(),
    refreshToken: vi.fn()
  },
  onTaskDeleted: vi.fn(() => vi.fn())
}))

afterEach(cleanup)

describe('EnterpriseLoginModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(enterpriseApi.signupInBrowser).mockResolvedValue({
      userId: 'user-1',
      email: 'new@example.com',
      companies: []
    })
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

  it('includes the AI subscription by default for browser signup', async () => {
    render(<EnterpriseLoginModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Sign up in browser'))

    await waitFor(() => {
      expect(enterpriseApi.signupInBrowser).toHaveBeenCalledWith('register', {
        includeAiSubscription: true
      })
    })
  })

  it('can opt out of including the AI subscription for browser signup', async () => {
    render(<EnterpriseLoginModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Include AI subscription'))
    fireEvent.click(screen.getByText('Sign up in browser'))

    await waitFor(() => {
      expect(enterpriseApi.signupInBrowser).toHaveBeenCalledWith('register', {
        includeAiSubscription: false
      })
    })
  })

  it('does not send an AI subscription preference for browser login', async () => {
    render(<EnterpriseLoginModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('Sign in via browser instead'))

    await waitFor(() => {
      expect(enterpriseApi.signupInBrowser).toHaveBeenCalledWith('login', undefined)
    })
  })
})
