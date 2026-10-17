import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { HarnessMaintenanceStatus } from '@shared/harness-maintenance'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/ipc-client', () => ({
  harnessMaintenanceApi: {
    get: (...args: unknown[]) => get(...args),
    refresh: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    updateAll: vi.fn(),
    onUpdated: vi.fn(() => vi.fn()),
    onProgress: vi.fn(() => vi.fn())
  }
}))

import { HarnessVersionWarning } from './HarnessVersionWarning'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'

const now = '2026-03-01T12:00:00.000Z'

function statusFor(overrides: Partial<HarnessMaintenanceStatus>): HarnessMaintenanceStatus {
  return {
    harness: 'codex',
    installed: true,
    binaryPath: '/Users/dev/.local/bin/codex',
    version: '0.1.0',
    latestVersion: null,
    status: 'up_to_date',
    installer: 'native',
    canUpdate: true,
    updateCommand: 'codex update',
    checkedAt: now,
    ...overrides
  }
}

beforeEach(() => {
  cleanup()
  useHarnessMaintenanceStore.setState({ statuses: [], loaded: false, refreshing: false, error: null, updates: {} })
  get.mockReset().mockResolvedValue([])
})

describe('HarnessVersionWarning', () => {
  it('renders nothing for an unknown/unselected coding agent', async () => {
    await act(async () => { render(<HarnessVersionWarning codingAgent="" />) })
    expect(screen.queryByTestId('harness-version-warning')).toBeNull()
  })

  it('renders nothing when the harness is up to date', async () => {
    get.mockResolvedValue([statusFor({ status: 'up_to_date' })])
    await act(async () => { render(<HarnessVersionWarning codingAgent="codex" />) })
    expect(screen.queryByTestId('harness-version-warning')).toBeNull()
  })

  it('warns when the harness is below the recommended version', async () => {
    get.mockResolvedValue([statusFor({ status: 'below_recommended', version: '0.5.0' })])
    await act(async () => { render(<HarnessVersionWarning codingAgent="codex" />) })
    expect(screen.getByTestId('harness-version-warning').textContent).toContain('below 20x\'s recommended version')
  })

  it('warns more strongly when the harness is unsupported', async () => {
    get.mockResolvedValue([statusFor({ status: 'unsupported', version: '0.1.0' })])
    await act(async () => { render(<HarnessVersionWarning codingAgent="codex" />) })
    expect(screen.getByTestId('harness-version-warning').textContent).toContain('unsupported')
  })
})
