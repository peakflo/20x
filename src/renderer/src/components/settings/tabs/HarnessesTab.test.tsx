import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@/lib/ipc-client', () => ({
  harnessInstanceApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  harnessMaintenanceApi: {
    get: vi.fn().mockResolvedValue([]),
    refresh: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    updateAll: vi.fn(),
    onUpdated: vi.fn(() => vi.fn()),
    onProgress: vi.fn(() => vi.fn())
  },
  settingsApi: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue({})
  },
  acpInstanceApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    install: vi.fn(),
    validateLocalCommand: vi.fn()
  },
  acpRegistryApi: {
    search: vi.fn().mockResolvedValue([])
  }
}))

import { HarnessesTab } from './HarnessesTab'
import { useHarnessInstanceStore } from '@/stores/harness-instance-store'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'
import { useAcpInstanceStore } from '@/stores/acp-instance-store'

beforeEach(() => {
  cleanup()
  useHarnessInstanceStore.setState({ instances: [], loaded: false })
  useHarnessMaintenanceStore.setState({ statuses: [], loaded: false, refreshing: false, error: null, updates: {} })
  useAcpInstanceStore.setState({ instances: [], loaded: false })
})

describe('HarnessesTab', () => {
  it('renders all three sections — Accounts, Harnesses, and ACP agents', async () => {
    render(<HarnessesTab />)

    expect(await screen.findByText('Accounts')).toBeTruthy()
    expect(screen.getByText('Harnesses')).toBeTruthy()
    expect(screen.getByText('ACP agents')).toBeTruthy()
  })
})
