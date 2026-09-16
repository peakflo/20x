import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserPanelContent } from './BrowserPanelContent'
import { useCanvasStore } from '@/stores/canvas-store'

const mocks = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), status: vi.fn(), notify: vi.fn(),
  register: vi.fn(), unregister: vi.fn(), update: vi.fn(),
}))
vi.mock('@/lib/ipc-client', () => ({ browserRecordingApi: { start: mocks.start, stop: mocks.stop, status: mocks.status } }))
vi.mock('@/lib/browser-agent-notifications', () => ({ notifyAgentsOfBrowserRecording: mocks.notify }))
vi.mock('@/stores/canvas-store', () => {
  const state = { panels: [{ id: 'panel', type: 'browser', title: 'Portal' }], edges: [], updatePanel: mocks.update }
  return { useCanvasStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state, subscribe: () => () => {},
  }) }
})
const active = { id: 'recording', panelId: 'panel', title: 'Portal', status: 'recording', taskIds: [], stepCount: 2, gaps: [] }

describe('browser recording controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCanvasStore.getState().edges.splice(0)
    useCanvasStore.getState().panels.splice(1)
    mocks.status.mockResolvedValue({ recording: null })
    mocks.start.mockResolvedValue({ ok: true, recording: active })
    mocks.stop.mockResolvedValue({ ok: true, recording: { ...active, status: 'saved' } })
    mocks.notify.mockResolvedValue({ notified: [], failed: [] })
    mocks.register.mockResolvedValue({ success: true })
    mocks.unregister.mockResolvedValue({ success: true })
    Object.assign(window.electronAPI, { browser: {
      registerBrokerPanel: mocks.register,
      unregisterBrokerPanel: mocks.unregister,
      startRecording: mocks.start,
      stopRecording: mocks.stop,
      recordingStatus: mocks.status,
    } })
    Object.assign(globalThis, { React })
  })
  afterEach(cleanup)

  function mount() {
    const result = render(<BrowserPanelContent panelId="panel" />)
    Object.assign(result.container.querySelector('webview')!, { getWebContentsId: () => 10 })
    return result
  }

  it('saves before notification and prevents duplicate Stop calls', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: '● Record' }))
    const stop = await screen.findByRole('button', { name: '■ Stop recording' })
    let complete!: (result: unknown) => void
    mocks.stop.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    fireEvent.click(stop)
    fireEvent.click(stop)
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1))
    expect(mocks.notify).not.toHaveBeenCalled()
    complete({ ok: true, recording: { ...active, status: 'saved' } })
    await screen.findByText('Recording saved: 2 steps. No task agent is connected.')
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale status result after recording starts', async () => {
    let resolveStatus!: (result: { recording: null }) => void
    mocks.status.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve }))
    mount()
    fireEvent.click(screen.getByRole('button', { name: '● Record' }))
    await screen.findByRole('button', { name: '■ Stop recording' })
    resolveStatus({ recording: null })
    await Promise.resolve()
    expect(screen.getByRole('button', { name: '■ Stop recording' })).toBeEnabled()
  })

  it('keeps Stop available after a save error and does not notify', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: '● Record' }))
    const stop = await screen.findByRole('button', { name: '■ Stop recording' })
    mocks.stop.mockResolvedValue({ error: 'Disk is full.' })
    fireEvent.click(stop)
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk is full.')
    expect(screen.getByRole('button', { name: '■ Stop recording' })).toBeEnabled()
    expect(mocks.notify).not.toHaveBeenCalled()
  })
  it('registers current task links at Stop and retries only failed recipients', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: '● Record' }))
    const stop = await screen.findByRole('button', { name: '■ Stop recording' })
    const state = useCanvasStore.getState()
    state.panels.push({ id: 'task-panel', type: 'task', refId: 'task-new' } as never)
    state.edges.push({ id: 'edge', fromPanelId: 'panel', toPanelId: 'task-panel', edgeType: 'browser' })
    mocks.stop.mockResolvedValue({ ok: true, recording: { ...active, status: 'saved', taskIds: ['task-new', 'task-failed'] } })
    mocks.notify.mockResolvedValueOnce({ notified: ['task-new'], failed: ['task-failed'] })
    fireEvent.click(stop)
    const retry = await screen.findByRole('button', { name: 'Retry notification' })
    expect(mocks.register).toHaveBeenLastCalledWith({ panelId: 'panel', webContentsId: 10, taskIds: ['task-new'] })
    mocks.notify.mockResolvedValueOnce({ notified: ['task-failed'], failed: [] })
    fireEvent.click(retry)
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(2))
    expect(mocks.notify.mock.calls[1][1]).toEqual(['task-failed'])
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })

})
