import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { TaskConfirmation } from '../shared/task-confirmation'

/** Desktop-only consent, tied to one request and cancelled when its renderer leaves. */
export function registerTaskConfirmation(desktop: () => BrowserWindow | null) {
  let pending: { request: TaskConfirmation; window: BrowserWindow; finish: (approved: boolean) => void } | undefined
  const assertDesktop = (event: IpcMainInvokeEvent) => {
    const contents = desktop()?.webContents
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error('Confirm task actions in the main 20x window.')
  }
  ipcMain.handle('task-confirmation:current', event => { assertDesktop(event); return pending?.request ?? null })
  ipcMain.handle('task-confirmation:answer', (event, id: unknown, approved: unknown) => {
    assertDesktop(event)
    if (!pending || pending.window !== desktop() || pending.request.id !== id || typeof approved !== 'boolean') throw new Error('This confirmation is no longer available.')
    pending.finish(approved)
  })
  return (request: Omit<TaskConfirmation, 'id'> & { signal: AbortSignal }): Promise<boolean> => {
    const window = desktop()
    if (!window || window.isDestroyed() || request.signal.aborted) return Promise.resolve(false)
    if (pending) throw new Error('A task confirmation is already open.')
    const { signal, ...details } = request
    const contents = window.webContents
    return new Promise(resolve => {
      const cancel = () => finish(false)
      const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) cancel() }
      const finish = (approved: boolean) => {
        if (!pending || pending.request.id !== preview.id) return
        pending = undefined
        signal.removeEventListener('abort', cancel)
        contents.removeListener('destroyed', cancel)
        contents.removeListener('render-process-gone', cancel)
        contents.removeListener('did-start-navigation', navigate)
        try { if (!contents.isDestroyed()) contents.send('task-confirmation:changed', null) }
        catch { /* The renderer can disappear while the request is being settled. */ }
        resolve(approved && !signal.aborted)
      }
      const preview = { ...details, id: randomUUID() }
      pending = { request: preview, window, finish }
      signal.addEventListener('abort', cancel, { once: true })
      contents.once('destroyed', cancel)
      contents.once('render-process-gone', cancel)
      contents.on('did-start-navigation', navigate)
      try {
        if (window.isMinimized()) window.restore()
        window.show()
        contents.send('task-confirmation:changed', preview)
      } catch { cancel() }
    })
  }
}
