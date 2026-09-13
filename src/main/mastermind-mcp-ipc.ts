import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { DatabaseManager } from './database'
import type { ResponsibilityManager } from './responsibility-manager'
import { MastermindMcpInstaller } from './mastermind-mcp-installer'
import { mastermindMcpServerStatus, startMastermindMcpServer, stopMastermindMcpServer } from './mastermind-mcp-server'
import {
  MASTERMIND_MCP_SETTING, MASTERMIND_MCP_SKILL_VERSION, MASTERMIND_MCP_URL,
  type MastermindMcpClient, type MastermindMcpStatus
} from '../shared/mastermind-mcp'

const installer = new MastermindMcpInstaller()
const enabled = (db: DatabaseManager): boolean => db.getSetting(MASTERMIND_MCP_SETTING) === 'true'

async function status(db: DatabaseManager): Promise<MastermindMcpStatus> {
  const runtime = mastermindMcpServerStatus()
  return {
    enabled: enabled(db), running: runtime.running, url: MASTERMIND_MCP_URL,
    ...(runtime.error ? { error: runtime.error } : {}),
    skillVersion: MASTERMIND_MCP_SKILL_VERSION,
    clients: await installer.statuses()
  }
}

export async function startConfiguredMastermindMcp(db: DatabaseManager, manager: ResponsibilityManager): Promise<void> {
  if (!enabled(db)) return
  await startMastermindMcpServer(manager)
}

export function registerMastermindMcpIpc(db: DatabaseManager, manager: ResponsibilityManager, desktop: () => WebContents | undefined): void {
  const assertDesktop = (event: IpcMainInvokeEvent): void => {
    const main = desktop()
    if (!main || event.sender !== main || event.senderFrame !== main.mainFrame) throw new Error('20x MCP settings must come from the main 20x window.')
  }
  ipcMain.handle('mastermindMcp:status', event => { assertDesktop(event); return status(db) })
  ipcMain.handle('mastermindMcp:setEnabled', async (event, value: boolean) => {
    assertDesktop(event)
    if (typeof value !== 'boolean') throw new Error('Enabled must be true or false.')
    db.setSetting(MASTERMIND_MCP_SETTING, String(value))
    if (value) await startMastermindMcpServer(manager)
    else stopMastermindMcpServer()
    return status(db)
  })
  ipcMain.handle('mastermindMcp:install', async (event, client: MastermindMcpClient) => {
    assertDesktop(event)
    if (!['codex', 'pi', 'claude'].includes(client)) throw new Error('Choose Codex, Pi, or Claude.')
    return installer.install(client, () => status(db))
  })
  ipcMain.handle('mastermindMcp:checkSkills', event => { assertDesktop(event); return status(db) })
}
