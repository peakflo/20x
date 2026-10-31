import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HarnessMaintenanceStatus } from '@shared/harness-maintenance'

const { get, update } = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))

vi.mock('@/lib/ipc-client', () => ({
  harnessMaintenanceApi: {
    get: (...args: unknown[]) => get(...args),
    refresh: vi.fn().mockResolvedValue([]),
    update,
    updateAll: vi.fn(),
    onUpdated: vi.fn(() => vi.fn()),
    onProgress: vi.fn(() => vi.fn())
  }
}))

import { HarnessUpdateNotice } from './HarnessUpdateNotice'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'
import { useUIStore } from '@/stores/ui-store'
import { useProgressToastStore } from '@/stores/progress-toast-store'
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
  update.mockReset()
  useProgressToastStore.setState({ toasts: new Map() })
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

  it('"Review" opens Settings on the Harnesses tab and dismisses the notice', async () => {
    get.mockResolvedValue([statusFor({ harness: 'codex', status: 'behind_latest' })])
    await act(async () => { render(<HarnessUpdateNotice />) })

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(useUIStore.getState().activeModal).toBe('settings')
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.HARNESSES)
    expect(screen.queryByTestId('harness-update-notice')).toBeNull()
  })

  it('updates a harness from the notice and shows the standard success toast', async () => {
    get.mockResolvedValue([statusFor({})])
    update.mockResolvedValue({
      harness: 'codex',
      run: { harness: 'codex', status: 'succeeded', message: 'Updated to 0.162.1.', startedAt: now },
      newStatus: statusFor({ version: '0.162.1', latestVersion: '0.162.1', status: 'up_to_date' })
    })
    await act(async () => { render(<HarnessUpdateNotice />) })

    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))

    await waitFor(() => expect(screen.queryByTestId('harness-update-notice')).toBeNull())
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('codex')
    const toast = useProgressToastStore.getState().toasts.get('harness-update')
    expect(toast?.status).toBe('done')
    expect(toast?.message).toContain('Updated to 0.162.1.')
    expect(useUIStore.getState().activeModal).toBeNull()
  })

  it('can be hidden while updating; progress moves to a toast and success replaces it', async () => {
    get.mockResolvedValue([statusFor({})])
    let resolveUpdate: (value: unknown) => void = () => {}
    update.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve }))
    await act(async () => { render(<HarnessUpdateNotice />) })

    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    await waitFor(() => expect(screen.getByTestId('harness-update-notice').textContent).toContain('Updating harness'))

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('harness-update-notice')).toBeNull()
    expect(useProgressToastStore.getState().toasts.get('harness-update')?.status).toBe('running')

    await act(async () => {
      resolveUpdate({
        harness: 'codex',
        run: { harness: 'codex', status: 'succeeded', message: 'Updated.', startedAt: now },
        newStatus: statusFor({ version: '0.162.1', latestVersion: '0.162.1', status: 'up_to_date' })
      })
    })

    await waitFor(() => expect(useProgressToastStore.getState().toasts.get('harness-update')?.status).toBe('done'))
    expect(screen.queryByTestId('harness-update-notice')).toBeNull()
  })

  it('brings a hidden notice back when the update fails', async () => {
    get.mockResolvedValue([statusFor({})])
    let resolveUpdate: (value: unknown) => void = () => {}
    update.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve }))
    await act(async () => { render(<HarnessUpdateNotice />) })

    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))

    await act(async () => {
      resolveUpdate({
        harness: 'codex',
        run: { harness: 'codex', status: 'failed', message: 'Update command failed.', startedAt: now },
        newStatus: statusFor({})
      })
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy())
    expect(useProgressToastStore.getState().toasts.has('harness-update')).toBe(false)
  })

  it('shows a failed update and allows a retry from the notice', async () => {
    get.mockResolvedValue([statusFor({})])
    update.mockResolvedValue({
      harness: 'codex',
      run: { harness: 'codex', status: 'failed', message: 'Update command failed.', startedAt: now },
      newStatus: statusFor({})
    })
    await act(async () => { render(<HarnessUpdateNotice />) })

    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy())
    expect(screen.getByTestId('harness-update-notice').textContent).toContain('Update command failed.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  })

  it('updates each eligible harness in a combined notice', async () => {
    get.mockResolvedValue([
      statusFor({ harness: 'codex' }),
      statusFor({ harness: 'opencode', version: '1.0.0', latestVersion: '1.1.0' }),
      statusFor({ harness: 'pi', canUpdate: false, installer: 'manual' })
    ])
    update.mockImplementation(async (harness: string) => ({
      harness,
      run: { harness, status: 'succeeded', message: 'Updated.', startedAt: now },
      newStatus: statusFor({ harness: harness as HarnessMaintenanceStatus['harness'], status: 'up_to_date' })
    }))
    await act(async () => { render(<HarnessUpdateNotice />) })

    fireEvent.click(screen.getByRole('button', { name: 'Update all' }))

    await waitFor(() => expect(useProgressToastStore.getState().toasts.get('harness-update')?.status).toBe('done'))
    expect(update.mock.calls.map(([harness]) => harness)).toEqual(['codex', 'opencode'])
    // The manual-update harness stays in the notice; the updated ones are gone.
    const notice = screen.getByTestId('harness-update-notice')
    expect(notice.textContent).toContain('Pi')
    expect(notice.textContent).not.toContain('Codex')
  })

  it('keeps Review for installs that need a manual update', async () => {
    get.mockResolvedValue([statusFor({ canUpdate: false, installer: 'manual' })])
    await act(async () => { render(<HarnessUpdateNotice />) })

    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.HARNESSES)
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
