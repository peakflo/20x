import { expect, it, vi } from 'vitest'
import { dialog, ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { registerResponsibilityIpc, recordResponsibilityHumanInput } from './responsibility-ipc'
import type { ResponsibilityManager } from './responsibility-manager'

it('opens a directory picker only for the desktop and returns no path on cancellation', async () => {
  vi.mocked(ipcMain.handle).mockClear()
  const service = {} as ResponsibilityManager
  const main = { mainFrame: {} } as WebContents
  registerResponsibilityIpc(service, () => main)
  const handle = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'responsibilities:pickProjectFolder')![1]
  await expect(handle({ sender: main, senderFrame: {} } as IpcMainInvokeEvent)).rejects.toThrow('main 20x window')
  expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  const event = { sender: main, senderFrame: main.mainFrame } as IpcMainInvokeEvent
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/project with spaces'] })
  expect(await handle(event)).toBe('/project with spaces')
  expect(dialog.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory'] }))
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: ['/ignored'] })
  expect(await handle(event)).toBeNull()
  vi.mocked(ipcMain.handle).mockClear()
})

it('accepts agreement approvals and human provenance only from the main desktop frame', () => {
  const service = { act: vi.fn(), ownsTask: () => true, recordHumanInput: vi.fn() } as unknown as ResponsibilityManager
  const main = { mainFrame: {} } as WebContents
  registerResponsibilityIpc(service, () => main)
  const handle = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'responsibilities:act')![1]
  const desktop = { sender: main, senderFrame: main.mainFrame } as IpcMainInvokeEvent
  const embedded = { sender: main, senderFrame: {} } as IpcMainInvokeEvent
  expect(() => handle(embedded, 'goal', 1, 'approve')).toThrow('main 20x window')
  expect(() => recordResponsibilityHumanInput('project', 'May deploy', embedded)).toThrow('main 20x window')
  expect(service.act).not.toHaveBeenCalled()
  handle(desktop, 'goal', 1, 'approve')
  recordResponsibilityHumanInput('project', 'My actual request', desktop)
  expect(service.act).toHaveBeenCalledWith('goal', 1, 'approve')
  expect(service.recordHumanInput).toHaveBeenCalledWith('project', 'My actual request')
})

it('keeps Factory confirmation on the trusted desktop frame', () => {
  vi.mocked(ipcMain.handle).mockClear()
  const service = { decideFactory: vi.fn() } as unknown as ResponsibilityManager
  const main = { mainFrame: {} } as WebContents
  registerResponsibilityIpc(service, () => main)
  const handle = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'responsibilities:decideFactory')![1]
  expect(() => handle({ sender: main, senderFrame: {} } as IpcMainInvokeEvent, 'preview', true)).toThrow('main 20x window')
  expect(service.decideFactory).not.toHaveBeenCalled()
  handle({ sender: main, senderFrame: main.mainFrame } as IpcMainInvokeEvent, 'preview', true)
  expect(service.decideFactory).toHaveBeenCalledWith('preview', true)
})
