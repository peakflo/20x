import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { EnterpriseSettings } from './EnterpriseSettings'

vi.mock('@/stores/enterprise-store', () => ({
  useEnterpriseStore: () => ({
    isAuthenticated: true,
    isLoading: false,
    isSyncing: false,
    userEmail: 'user@example.com',
    currentTenant: { id: 'tenant-1', name: 'Example' },
    lastSyncStats: null,
    lastSyncMs: null,
    switchOrg: vi.fn(),
    logout: vi.fn(),
    loadSession: vi.fn(),
    setSyncing: vi.fn(),
    setSyncResult: vi.fn()
  })
}))

vi.mock('@/lib/ipc-client', () => ({
  enterpriseApi: {
    getAiGatewayStatus: vi.fn().mockResolvedValue({
      configured: true,
      modelCount: 1,
      keyName: null,
      expiresAt: null,
      subscription: {
        planId: 'standard',
        planName: 'Standard',
        status: 'active',
        currentPeriodEnd: '2026-10-27T00:00:00.000Z'
      }
    }),
    apiRequest: vi.fn().mockResolvedValue({
      active: true,
      usage: { usedUsd: 20, limitUsd: 20, percentUsed: 100, resetAt: '2026-10-01T00:00:00.000Z' }
    })
  },
  skillApi: { getAll: vi.fn().mockResolvedValue([]) }
}))

vi.mock('./EnterpriseLoginModal', () => ({ EnterpriseLoginModal: () => null }))

afterEach(cleanup)

describe('EnterpriseSettings AI subscription', () => {
  it('shows the usage reset separately from the plan period end', async () => {
    render(<EnterpriseSettings />)

    expect(await screen.findByText(/Usage resets 10\/1\/2026 \(UTC\)/)).toBeInTheDocument()
    expect(screen.getByText(/Plan period ends 10\/27\/2026/)).toBeInTheDocument()
  })
})
