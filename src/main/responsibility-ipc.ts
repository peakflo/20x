import { dialog, ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import type { ResponsibilityManager } from './responsibility-manager'

let manager: ResponsibilityManager | undefined
let desktop: (() => WebContents | undefined) | undefined
function assertDesktop(event: IpcMainInvokeEvent): void {
  const main = desktop?.()
  if (!main || event.sender !== main || event.senderFrame !== main.mainFrame) throw new Error('Responsibility decisions must come from the main 20x window.')
}
export function recordResponsibilityHumanInput(taskId: string, message: string, event: IpcMainInvokeEvent): void {
  if (!manager?.ownsTask(taskId)) return
  assertDesktop(event); manager.recordHumanInput(taskId, message)
}

/** Human decisions are desktop IPC only. There is intentionally no approval MCP/HTTP route. */
export function registerResponsibilityIpc(service: ResponsibilityManager, mainWindow: () => WebContents | undefined): void {
  manager = service; desktop = mainWindow
  ipcMain.handle('responsibilities:snapshot', (event, projectId?: string) => { assertDesktop(event); return service.snapshot(projectId) })
  ipcMain.handle('responsibilities:pickProjectFolder', async event => {
    assertDesktop(event)
    const result = await dialog.showOpenDialog({ title: 'Select project folder', buttonLabel: 'Select folder', properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('responsibilities:createProject', (event, name: string, root: string, agentId: string) => { assertDesktop(event); return service.createProject(name, root, agentId) })
  ipcMain.handle('responsibilities:act', (event, id: string, revision: number, action: string) => { assertDesktop(event); return service.act(id, revision, action) })
  ipcMain.handle('responsibilities:answer', (event, id: string, answer: string, approved?: boolean) => { assertDesktop(event); return service.answer(id, answer, approved) })
  ipcMain.handle('responsibilities:remember', (event, projectId: string, kind: 'fact' | 'preference', text: string, id?: string) => { assertDesktop(event); return service.remember(projectId, kind, text, id) })
  ipcMain.handle('responsibilities:forget', (event, id: string) => { assertDesktop(event); return service.forget(id) })
}
