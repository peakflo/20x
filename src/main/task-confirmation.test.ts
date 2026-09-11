import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { registerTaskConfirmation } from './task-confirmation'

function fixture() {
  vi.mocked(ipcMain.handle).mockClear()
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: vi.fn() })
  const window = { webContents: contents, isDestroyed: () => false, isMinimized: () => false, show: vi.fn() } as unknown as BrowserWindow
  const confirm = registerTaskConfirmation(() => window)
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent
  const call = (name: string, ...args: unknown[]) => vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === `task-confirmation:${name}`)![1](event, ...args)
  const abort = new AbortController()
  const ask = () => confirm({ title: 'Delete 100 tasks?', detail: 'Full reviewed list', confirmLabel: 'Delete 100 tasks', signal: abort.signal })
  return { contents, confirm, event, call, abort, ask }
}

describe('desktop task confirmation', () => {
  it('accepts only the matching request from the desktop frame, once', async () => {
    const f = fixture()
    const result = f.ask()
    const request = f.call('current')
    expect(f.contents.send).toHaveBeenCalledWith('task-confirmation:changed', request)
    const answer = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'task-confirmation:answer')![1]
    expect(() => answer({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, request.id, true)).toThrow('main 20x window')
    expect(() => f.call('answer', 'old-request', true)).toThrow('no longer available')
    expect(() => f.call('answer', request.id, 'true')).toThrow('no longer available')
    f.call('answer', request.id, true)
    expect(await result).toBe(true)
    expect(f.call('current')).toBeNull()
    expect(() => f.call('answer', request.id, true)).toThrow('no longer available')
    expect(f.contents.eventNames()).toHaveLength(0)
  })

  it.each(['cancel', 'quit', 'reload', 'destroyed', 'render-process-gone'])('declines on %s and removes listeners', async reason => {
    const f = fixture()
    const result = f.ask()
    if (reason === 'cancel') f.call('answer', f.call('current').id, false)
    else if (reason === 'quit') f.abort.abort()
    else if (reason === 'reload') f.contents.emit('did-start-navigation', {}, 'file:///app', false, true)
    else f.contents.emit(reason)
    expect(await result).toBe(false)
    expect(f.call('current')).toBeNull()
    expect(f.contents.eventNames()).toHaveLength(0)
  })
})
