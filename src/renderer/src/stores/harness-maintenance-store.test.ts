import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessMaintenanceStatus } from '@shared/harness-maintenance'

const { get, refresh, update, updateAll, onUpdated, onProgress } = vi.hoisted(() => ({
  get: vi.fn(),
  refresh: vi.fn(),
  update: vi.fn(),
  updateAll: vi.fn(),
  onUpdated: vi.fn((_cb: (s: HarnessMaintenanceStatus[]) => void) => vi.fn()),
  onProgress: vi.fn((_cb: (d: { harness: string; chunk: string }) => void) => vi.fn())
}))

vi.mock('@/lib/ipc-client', () => ({
  harnessMaintenanceApi: { get, refresh, update, updateAll, onUpdated, onProgress }
}))

import { useHarnessMaintenanceStore } from './harness-maintenance-store'

const now = '2026-03-01T12:00:00.000Z'

function statusFor(harness: string, overrides: Partial<HarnessMaintenanceStatus> = {}): HarnessMaintenanceStatus {
  return {
    harness: harness as HarnessMaintenanceStatus['harness'],
    installed: true,
    binaryPath: `/Users/dev/.local/bin/${harness}`,
    version: '0.1.0',
    latestVersion: null,
    status: 'up_to_date',
    installer: 'native',
    canUpdate: true,
    updateCommand: `${harness} update`,
    checkedAt: now,
    ...overrides
  }
}

beforeEach(() => {
  useHarnessMaintenanceStore.setState({ statuses: [], loaded: false, refreshing: false, error: null, updates: {} })
  get.mockReset().mockResolvedValue([])
  refresh.mockReset()
  update.mockReset()
  updateAll.mockReset()
  onUpdated.mockReset().mockReturnValue(vi.fn())
  onProgress.mockReset().mockReturnValue(vi.fn())
})

describe('useHarnessMaintenanceStore', () => {
  it('loads statuses on init', async () => {
    get.mockResolvedValue([statusFor('codex')])
    const unsubscribe = useHarnessMaintenanceStore.getState().init()
    await vi.waitFor(() => expect(useHarnessMaintenanceStore.getState().loaded).toBe(true))
    expect(useHarnessMaintenanceStore.getState().statuses).toHaveLength(1)
    unsubscribe()
  })

  it('upserts by harness, replacing an existing entry rather than duplicating it', () => {
    useHarnessMaintenanceStore.setState({ statuses: [statusFor('codex', { version: '0.1.0' })] })
    useHarnessMaintenanceStore.getState().upsertMany([statusFor('codex', { version: '0.2.0' })])
    const statuses = useHarnessMaintenanceStore.getState().statuses
    expect(statuses).toHaveLength(1)
    expect(statuses[0].version).toBe('0.2.0')
  })

  it('refresh(fresh) calls the API with fresh and replaces statuses', async () => {
    refresh.mockResolvedValue([statusFor('opencode')])
    await useHarnessMaintenanceStore.getState().refresh(true)
    expect(refresh).toHaveBeenCalledWith(true)
    expect(useHarnessMaintenanceStore.getState().statuses.map((s) => s.harness)).toEqual(['opencode'])
  })

  it('update() marks the harness running, then applies the result', async () => {
    let resolveUpdate!: (value: unknown) => void
    update.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve }))

    const promise = useHarnessMaintenanceStore.getState().update('codex')
    expect(useHarnessMaintenanceStore.getState().updates.codex?.running).toBe(true)

    resolveUpdate({
      harness: 'codex',
      run: { harness: 'codex', status: 'succeeded', message: 'Updated.', startedAt: now },
      newStatus: statusFor('codex', { version: '0.2.0' })
    })
    await promise

    const state = useHarnessMaintenanceStore.getState()
    expect(state.updates.codex?.running).toBe(false)
    expect(state.updates.codex?.run?.status).toBe('succeeded')
    expect(state.statuses.find((s) => s.harness === 'codex')?.version).toBe('0.2.0')
  })

  it('update() reports a failed run when the API call rejects', async () => {
    update.mockRejectedValue(new Error('boom'))
    await useHarnessMaintenanceStore.getState().update('codex')
    const run = useHarnessMaintenanceStore.getState().updates.codex?.run
    expect(run?.status).toBe('failed')
    expect(run?.message).toBe('boom')
  })

  it('updateAll() only marks harnesses that canUpdate as running', async () => {
    useHarnessMaintenanceStore.setState({
      statuses: [statusFor('codex', { canUpdate: true }), statusFor('cursor', { canUpdate: false })]
    })
    let resolveAll!: (value: unknown) => void
    updateAll.mockReturnValue(new Promise((resolve) => { resolveAll = resolve }))

    const promise = useHarnessMaintenanceStore.getState().updateAll()
    expect(useHarnessMaintenanceStore.getState().updates.codex?.running).toBe(true)
    expect(useHarnessMaintenanceStore.getState().updates.cursor).toBeUndefined()

    resolveAll({ results: [{ harness: 'codex', run: { harness: 'codex', status: 'succeeded', startedAt: now }, newStatus: statusFor('codex') }], skipped: ['cursor'] })
    await promise
    expect(useHarnessMaintenanceStore.getState().updates.codex?.running).toBe(false)
  })

  it('onProgress events accumulate into the running harness\'s progress text', () => {
    useHarnessMaintenanceStore.getState().init()
    const handler = onProgress.mock.calls[0][0] as (d: { harness: string; chunk: string }) => void
    handler({ harness: 'codex', chunk: 'Running codex update\n' })
    handler({ harness: 'codex', chunk: 'done\n' })
    expect(useHarnessMaintenanceStore.getState().updates.codex?.progress).toBe('Running codex update\ndone\n')
  })
})
