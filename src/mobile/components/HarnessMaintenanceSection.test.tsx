import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HarnessMaintenanceStatus } from '@shared/harness-maintenance'

const { getMock, refreshMock, updateMock, eventHandlers } = vi.hoisted(() => ({
  getMock: vi.fn(),
  refreshMock: vi.fn(),
  updateMock: vi.fn(),
  eventHandlers: new Map<string, Set<(payload: unknown) => void>>()
}))

vi.mock('../api/client', () => ({
  api: {
    harnessMaintenance: {
      get: (...args: unknown[]) => getMock(...args),
      refresh: (...args: unknown[]) => refreshMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      updateAll: vi.fn()
    }
  }
}))

vi.mock('../api/websocket', () => ({
  onEvent: (type: string, handler: (payload: unknown) => void) => {
    if (!eventHandlers.has(type)) eventHandlers.set(type, new Set())
    eventHandlers.get(type)!.add(handler)
    return () => eventHandlers.get(type)?.delete(handler)
  }
}))

function emit(type: string, payload: unknown): void {
  for (const handler of eventHandlers.get(type) ?? []) handler(payload)
}

import { HarnessMaintenanceSection } from './HarnessMaintenanceSection'

const now = '2026-03-01T12:00:00.000Z'

const codex: HarnessMaintenanceStatus = {
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

const cursor: HarnessMaintenanceStatus = {
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

beforeEach(() => {
  cleanup()
  eventHandlers.clear()
  getMock.mockReset().mockResolvedValue([codex, cursor])
  refreshMock.mockReset().mockResolvedValue([codex, cursor])
  updateMock.mockReset()
})

describe('HarnessMaintenanceSection (mobile, read-only + Update now)', () => {
  it('lists every harness with its status', async () => {
    await act(async () => { render(<HarnessMaintenanceSection />) })
    const codexRow = await screen.findByTestId('mobile-harness-codex')
    expect(within(codexRow).getByText('Update available')).toBeTruthy()
    expect(within(codexRow).getByText(/v0\.1\.0/)).toBeTruthy()

    const cursorRow = screen.getByTestId('mobile-harness-cursor')
    expect(within(cursorRow).getByText('Updates with 20x')).toBeTruthy()
  })

  it('shows "Update now" only where canUpdate is true', async () => {
    await act(async () => { render(<HarnessMaintenanceSection />) })
    await screen.findByTestId('mobile-harness-codex')
    expect(within(screen.getByTestId('mobile-harness-codex')).getByText('Update now')).toBeTruthy()
    expect(within(screen.getByTestId('mobile-harness-cursor')).queryByText('Update now')).toBeNull()
  })

  it('triggers an update and applies the returned status', async () => {
    updateMock.mockResolvedValue({
      harness: 'codex',
      run: { harness: 'codex', status: 'succeeded', message: 'Updated.', startedAt: now, finishedAt: now },
      newStatus: { ...codex, version: '0.20.0', status: 'up_to_date' }
    })
    await act(async () => { render(<HarnessMaintenanceSection />) })
    await screen.findByTestId('mobile-harness-codex')

    fireEvent.click(within(screen.getByTestId('mobile-harness-codex')).getByText('Update now'))
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('codex'))
    await waitFor(() => expect(within(screen.getByTestId('mobile-harness-codex')).getByText(/v0\.20\.0/)).toBeTruthy())
  })

  it('re-checks on "Check now"', async () => {
    await act(async () => { render(<HarnessMaintenanceSection />) })
    await screen.findByTestId('mobile-harness-codex')

    fireEvent.click(screen.getByText('Check now'))
    await waitFor(() => expect(refreshMock).toHaveBeenCalledWith(true))
  })

  it('applies a pushed status broadcast without a page reload', async () => {
    await act(async () => { render(<HarnessMaintenanceSection />) })
    await screen.findByTestId('mobile-harness-codex')

    act(() => { emit('harness-maintenance:updated', [{ ...codex, status: 'up_to_date', version: '0.20.0' }]) })
    await waitFor(() => expect(within(screen.getByTestId('mobile-harness-codex')).getByText('Up to date')).toBeTruthy())
  })
})
