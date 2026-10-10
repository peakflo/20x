import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

import { HarnessUpdateNotice } from './HarnessUpdateNotice'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'

const now = '2026-03-01T12:00:00.000Z'

function statusFor(overrides: Partial<HarnessMaintenanceStatus>): HarnessMaintenanceStatus {
  return {
    harness: 'codex',
    installed: true,
    binaryPath: '/Users/dev/.local/bin/codex',
    version: '0.160.0',
    latestVersion: '0.162.1',
    status: 'behind_latest',
    installer: 'native',
    canUpdate: true,
    updateCommand: 'codex update',
    checkedAt: now,
    ...overrides
  }
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  useHarnessMaintenanceStore.setState({ statuses: [], loaded: false, refreshing: false, error: null, updates: {} })
  useUIStore.setState({ activeModal: null, settingsTab: SettingsTab.GENERAL } as Partial<ReturnType<typeof useUIStore.getState>>)
  get.mockReset().mockResolvedValue([])
})

describe('HarnessUpdateNotice', () => {
  it('renders nothing when nothing needs attention', async () => {
    get.mockResolvedValue([statusFor({ status: 'up_to_date', latestVersion: '0.160.0' })])
    await act(async () => { render(<HarnessUpdateNotice />) })
    expect(screen.queryByTestId('harness-update-notice')).toBeNull()
  })

  it('shows a visible notice — not just a status-bar dot — for a flagged harness, from outside Settings', async () => {
    get.mockResolvedValue([statusFor({ harness: 'codex', status: 'behind_latest' })])
    await act(async () => { render(<HarnessUpdateNotice />) })
    const notice = screen.getByTestId('harness-update-notice')
    expect(notice.textContent).toContain('Codex update available')
    expect(notice.textContent).toContain('0.160.0')
    expect(notice.textContent).toContain('0.162.1')
  })

  it('combines multiple flagged harnesses into one notice', async () => {
    get.mockResolvedValue([
      statusFor({ harness: 'codex', status: 'behind_latest' }),
      statusFor({ harness: 'opencode', status: 'below_recommended', version: '1.0.0', latestVersion: null })
    ])
    await act(async () => { render(<HarnessUpdateNotice />) })
    expect(screen.getByTestId('harness-update-notice').textContent).toContain('2 harness updates available')
  })

  it('"Review" opens Settings on the Agents tab and dismisses the notice', async () => {
    get.mockResolvedValue([statusFor({ harness: 'codex', status: 'behind_latest' })])
    await act(async () => { render(<HarnessUpdateNotice />) })

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.AGENTS)
    expect(screen.queryByTestId('harness-update-notice')).toBeNull()
  })

  it('"Dismiss" hides the notice without opening Settings, and it does not reappear for the same version', async () => {
    get.mockResolvedValue([statusFor({ harness: 'codex', status: 'behind_latest' })])
    await act(async () => { render(<HarnessUpdateNotice />) })

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useUIStore.getState().activeModal).toBeNull()
    expect(screen.queryByTestId('harness-update-notice')).toBeNull()

    // A fresh mount with the same status (e.g. after a reload) should not show it again.
    cleanup()
    await act(async () => { render(<HarnessUpdateNotice />) })
    expect(screen.queryByTestId('harness-update-notice')).toBeNull()
  })

  it('shows a new notice when the latest version changes after a dismissal', async () => {
    get.mockResolvedValue([statusFor({ harness: 'codex', status: 'behind_latest', latestVersion: '0.162.1' })])
    await act(async () => { render(<HarnessUpdateNotice />) })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    cleanup()

    get.mockResolvedValue([statusFor({ harness: 'codex', status: 'behind_latest', latestVersion: '0.170.0' })])
    await act(async () => { render(<HarnessUpdateNotice />) })
    expect(screen.getByTestId('harness-update-notice').textContent).toContain('0.170.0')
  })
})
