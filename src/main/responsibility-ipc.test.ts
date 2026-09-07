import { expect, it, vi } from 'vitest'
import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { registerResponsibilityIpc, recordResponsibilityHumanInput } from './responsibility-ipc'
import type { ResponsibilityManager } from './responsibility-manager'

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
