import { ipcMain } from 'electron'
import type { EnterpriseRunnerRuntime } from './runtime'
import type { RunOnChoice } from '../../shared/enterprise-runners'

/** Registers `enterpriseRunners:*` handlers. Every handler fails closed when signed out. */
export function registerEnterpriseRunnerIpc(getRuntime: () => EnterpriseRunnerRuntime | undefined): void {
  const need = (): EnterpriseRunnerRuntime => {
    const rt = getRuntime()
    if (!rt) throw new Error('Sign in to Peakflo Enterprise to use runners.')
    return rt
  }
  ipcMain.handle('enterpriseRunners:list', async () => {
    const rt = getRuntime()
    if (!rt) return { ok: false, error: 'Sign in to Peakflo Enterprise to use runners.', code: 'signed-out' }
    return rt.service.listRunners()
  })
  ipcMain.handle('enterpriseRunners:agentInfo', (_, agentId: string) => need().service.getAgentInfo(String(agentId)))
  ipcMain.handle('enterpriseRunners:getRunOn', (_, taskId: string) => {
    const rt = getRuntime()
    return rt ? rt.service.getTaskRunOn(String(taskId)) : { choice: { kind: 'local' }, locked: false }
  })
  ipcMain.handle('enterpriseRunners:setRunOn', (_, taskId: string, choice: RunOnChoice) => need().service.setTaskRunOn(String(taskId), choice))
  ipcMain.handle('enterpriseRunners:taskState', (_, taskId: string) => getRuntime()?.service.getTaskState(String(taskId)) ?? null)
  ipcMain.handle('enterpriseRunners:reassign', (_, taskId: string, runnerId: string) => need().service.reassign(String(taskId), String(runnerId)))
  ipcMain.handle('enterpriseRunners:openLocally', (_, taskId: string) => need().service.openLocally(String(taskId)))
  ipcMain.handle('enterpriseRunners:listArtifacts', (_, taskId: string) => {
    const rt = getRuntime()
    return rt ? rt.service.listSpacesArtifacts(String(taskId)) : { status: 'signed-out', artifacts: [], syncedAt: null }
  })
  ipcMain.handle('enterpriseRunners:readArtifact', (_, taskId: string, id: string) => need().service.readSpacesArtifact(String(taskId), String(id)))
}
