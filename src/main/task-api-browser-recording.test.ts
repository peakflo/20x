import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRoute } from './task-api-server'

const recordings = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), steps: vi.fn(), snapshot: vi.fn() }))
vi.mock('./panel-browser-broker', () => ({ panelBrowserBroker: { recordings } }))
const db = { getTask: (id: string) => id === 'task-1' ? { id } : undefined } as never
const handle = (name: string, params: Record<string, unknown> = {}) =>
  handleRoute(db, `/browser_recording_${name}`, { task_id: 'task-1', ...params })

beforeEach(() => { vi.resetAllMocks() })

describe('saved browser recording API', () => {
  it('lists saved recordings with a bounded page and next offset', async () => {
    recordings.list.mockReturnValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }])
    expect(await handle('list', { offset: 1, limit: 1 })).toEqual({ recordings: [{ id: 'r2' }], total: 3, nextOffset: 2 })
    expect(recordings.list).toHaveBeenCalledWith('task-1')
  })

  it('reads summary, steps, and snapshot through task-scoped service calls', async () => {
    recordings.get.mockReturnValue({ id: 'r1', status: 'completed' })
    recordings.steps.mockReturnValue({ steps: [{ snapshotId: 's1' }], total: 1, nextOffset: null })
    recordings.snapshot.mockReturnValue({ id: 's1' })
    expect(await handle('get', { recording_id: 'r1' })).toEqual({ recording: { id: 'r1', status: 'completed' } })
    expect(await handle('steps', { recording_id: 'r1' })).toEqual({ steps: [{ snapshotId: 's1' }], total: 1, nextOffset: null })
    expect(await handle('snapshot', { recording_id: 'r1', snapshot_id: 's1' })).toEqual({ snapshot: { id: 's1' } })
    expect(recordings.get).toHaveBeenCalledWith('task-1', 'r1')
    expect(recordings.steps).toHaveBeenCalledWith('task-1', 'r1', 0, 50)
    expect(recordings.snapshot).toHaveBeenCalledWith('task-1', 'r1', 's1')
  })

  it.each([{ offset: -1 }, { offset: 1.5 }, { offset: '0' }, { offset: Infinity }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }])('rejects invalid paging %j', async (params) => {
    expect(await handle('list', params)).toHaveProperty('error')
    expect(await handle('steps', { recording_id: 'r1', ...params })).toHaveProperty('error')
    expect(recordings.list).not.toHaveBeenCalled()
    expect(recordings.steps).not.toHaveBeenCalled()
  })

  it.each(['../secret', '/tmp/secret', '', 'a'.repeat(129), 'r1.json'])('rejects paths and invalid identifiers: %s', async (id) => {
    expect(await handle('get', { recording_id: id })).toHaveProperty('error')
    expect(await handle('snapshot', { recording_id: 'r1', snapshot_id: id })).toHaveProperty('error')
    expect(recordings.get).not.toHaveBeenCalled()
    expect(recordings.snapshot).not.toHaveBeenCalled()
  })

  it('does not access storage for a missing task', async () => {
    expect(await handle('list', { task_id: 'unknown' })).toEqual({ error: 'Task not found' })
    expect(recordings.list).not.toHaveBeenCalled()
  })

  it('reports service access denial without returning recording data', async () => {
    recordings.get.mockImplementation(() => { throw new Error('Recording not found for this task') })
    expect(await handle('get', { recording_id: 'r-other' })).toEqual({ error: 'Recording not found for this task' })
  })
})
