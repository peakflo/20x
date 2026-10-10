import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HarnessMaintenanceStatus, HarnessUpdateResult } from '@shared/harness-maintenance'

const get = vi.fn()
const refresh = vi.fn()
const update = vi.fn()
const updateAll = vi.fn()
const onUpdated = vi.fn((_cb: (s: HarnessMaintenanceStatus[]) => void) => vi.fn())
const onProgress = vi.fn((_cb: (d: { harness: string; chunk: string }) => void) => vi.fn())
const settingsGet = vi.fn()
const settingsSet = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  harnessMaintenanceApi: {
    get: (...args: unknown[]) => get(...args),
    refresh: (...args: unknown[]) => refresh(...args),
    update: (...args: unknown[]) => update(...args),
    updateAll: (...args: unknown[]) => updateAll(...args),
    onUpdated: (...args: Parameters<typeof onUpdated>) => onUpdated(...args),
    onProgress: (...args: Parameters<typeof onProgress>) => onProgress(...args)
  },
  settingsApi: {
    get: (...args: unknown[]) => settingsGet(...args),
    set: (...args: unknown[]) => settingsSet(...args)
  }
}))

import { HarnessesSection } from './HarnessesSection'
import { useHarnessMaintenanceStore } from '@/stores/harness-maintenance-store'

const now = '2026-03-01T12:00:00.000Z'

const upToDate: HarnessMaintenanceStatus = {
  harness: 'claude-code',
  installed: true,
  binaryPath: '/Users/dev/.local/bin/claude',
  version: '2.1.0',
  latestVersion: '2.1.0',
  status: 'up_to_date',
  installer: 'native',
  canUpdate: true,
  updateCommand: 'claude update',
  checkedAt: now
}

const behindLatest: HarnessMaintenanceStatus = {
  harness: 'codex',
  installed: true,
  binaryPath: '/Users/dev/.local/bin/codex',
  version: '0.1.0',
  latestVersion: '0.20.0',
  status: 'behind_latest',
  installer: 'native',
  canUpdate: true,
  updateCommand: 'codex update',
  checkedAt: now
}

const manualOnly: HarnessMaintenanceStatus = {
  harness: 'pi',
  installed: true,
  binaryPath: '/Users/dev/.asdf/installs/pi/0.70.0/bin/pi',
  version: '0.70.0',
  latestVersion: null,
  status: 'unsupported',
  installer: 'manual',
  canUpdate: false,
  updateCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest',
  checkedAt: now
}

const notInstalled: HarnessMaintenanceStatus = {
  harness: 'opencode',
  installed: false,
  binaryPath: null,
  version: null,
  latestVersion: null,
  status: 'not_installed',
  installer: 'unknown',
  canUpdate: false,
  updateCommand: null,
  checkedAt: now
}

const bundled: HarnessMaintenanceStatus = {
  harness: 'cursor',
  installed: true,
  binaryPath: '/usr/local/bin/cursor-agent',
  version: '1.0.0',
  latestVersion: null,
  status: 'up_to_date',
  installer: 'bundled',
  canUpdate: false,
  updateCommand: null,
  checkedAt: now
}

const allStatuses = [upToDate, behindLatest, manualOnly, notInstalled, bundled]

beforeEach(() => {
  cleanup()
  useHarnessMaintenanceStore.setState({ statuses: [], loaded: false, refreshing: false, error: null, updates: {} })
  get.mockReset().mockResolvedValue(allStatuses)
  refresh.mockReset().mockResolvedValue(allStatuses)
  update.mockReset()
  updateAll.mockReset()
  onUpdated.mockReset().mockReturnValue(vi.fn())
  onProgress.mockReset().mockReturnValue(vi.fn())
  settingsGet.mockReset().mockResolvedValue('true')
  settingsSet.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  })
})

afterEach(() => {
  cleanup()
})

describe('HarnessesSection', () => {
  it('renders every harness with its badge, mirroring mixed states', async () => {
    render(<HarnessesSection />)
    await screen.findByTestId('harness-row-claude-code')

    expect(within(screen.getByTestId('harness-row-claude-code')).getByText('Up to date')).toBeTruthy()
    expect(within(screen.getByTestId('harness-row-codex')).getByText('Update available')).toBeTruthy()
    expect(within(screen.getByTestId('harness-row-pi')).getByText('Unsupported')).toBeTruthy()
    expect(within(screen.getByTestId('harness-row-pi')).getByText('Manual update')).toBeTruthy()
    expect(within(screen.getByTestId('harness-row-opencode')).getByText('Not installed')).toBeTruthy()
    expect(within(screen.getByTestId('harness-row-cursor')).getByText('Updates with 20x')).toBeTruthy()
  })

  it('shows "Update now" only for harnesses that can self-update', async () => {
    render(<HarnessesSection />)
    await screen.findByTestId('harness-row-codex')

    expect(screen.getByTestId('harness-update-codex')).toBeTruthy()
    expect(within(screen.getByTestId('harness-row-pi')).queryByText('Update now')).toBeNull()
    expect(within(screen.getByTestId('harness-row-cursor')).queryByText('Update now')).toBeNull()
  })

  it('runs an update on click and shows the result', async () => {
    const result: HarnessUpdateResult = {
      harness: 'codex',
      run: { harness: 'codex', status: 'succeeded', message: 'Updated.', startedAt: now, finishedAt: now },
      newStatus: { ...behindLatest, version: '0.20.0', status: 'up_to_date' }
    }
    update.mockResolvedValue(result)
    render(<HarnessesSection />)
    await screen.findByTestId('harness-update-codex')

    fireEvent.click(screen.getByTestId('harness-update-codex'))
    await waitFor(() => expect(update).toHaveBeenCalledWith('codex'))
    await waitFor(() => expect(screen.getByTestId('harness-result-codex').textContent).toContain('Updated.'))
  })

  it('copies the manual update command to the clipboard', async () => {
    render(<HarnessesSection />)
    const row = await screen.findByTestId('harness-row-pi')

    expect(within(row).getByText(manualOnly.updateCommand!)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: /copy update command/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(manualOnly.updateCommand)
  })

  it('"Update all" is disabled when nothing can update, enabled when something can', async () => {
    get.mockResolvedValue([manualOnly, notInstalled, bundled])
    render(<HarnessesSection />)
    await screen.findByTestId('harness-row-pi')
    expect(screen.getByRole('button', { name: /update all/i })).toBeDisabled()

    act(() => { useHarnessMaintenanceStore.setState({ statuses: allStatuses }) })
    await waitFor(() => expect(screen.getByRole('button', { name: /update all/i })).not.toBeDisabled())
  })

  it('"Update all" triggers updateAll and reports per-harness results', async () => {
    updateAll.mockResolvedValue({
      results: [{ harness: 'codex', run: { harness: 'codex', status: 'succeeded', message: 'Updated.', startedAt: now }, newStatus: upToDate }],
      skipped: ['pi']
    })
    render(<HarnessesSection />)
    await screen.findByTestId('harness-row-codex')

    fireEvent.click(screen.getByRole('button', { name: /update all/i }))
    await waitFor(() => expect(updateAll).toHaveBeenCalled())
  })

  it('"Check now" re-checks with fresh: true', async () => {
    render(<HarnessesSection />)
    await screen.findByTestId('harness-row-codex')

    fireEvent.click(screen.getByRole('button', { name: /check now/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(true))
  })

  it('toggles the "Check for harness updates" setting', async () => {
    settingsGet.mockResolvedValue('true')
    render(<HarnessesSection />)
    await screen.findByTestId('harness-row-codex')
    const toggle = await screen.findByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(toggle)
    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('harness_update_checks_enabled', 'false'))
  })
})
