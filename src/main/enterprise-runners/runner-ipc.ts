import { ipcMain } from 'electron'
import type { EnterpriseRunnerRuntime } from './runner-runtime'
import type { RunOnChoice } from '../../shared/enterprise-runners'

/** Registers `enterpriseRunners:*` handlers. Every handler fails closed when signed out. */
export function registerEnterpriseRunnerIpc(getRuntime: () => EnterpriseRunnerRuntime | undefined): void {
  const need = (): EnterpriseRunnerRuntime => {
    const rt = getRuntime()
    if (!rt) throw new Error('Sign in to Peakflo Enterprise to use runners.')
    return rt
  }
  ipcMain.handle('enterprise-runners:runners', async () => {
    const rt = getRuntime()
    if (!rt) return { ok: false, error: 'Sign in to Peakflo Enterprise to use runners.', code: 'signed-out' }
    return rt.service.listRunners()
  })
  ipcMain.handle('enterprise-runners:agent-info', (_, agentId: string) => need().service.getAgentInfo(String(agentId)))
  ipcMain.handle('enterprise-runners:get-run-on', (_, taskId: string) => {
    const rt = getRuntime()
    return rt ? rt.service.getTaskRunOn(String(taskId)) : { choice: { kind: 'local' }, locked: false }
  })
  ipcMain.handle('enterprise-runners:set-run-on', (_, taskId: string, choice: RunOnChoice) => need().service.setTaskRunOn(String(taskId), choice))
  ipcMain.handle('enterprise-runners:task-state', (_, taskId: string) => getRuntime()?.service.getTaskState(String(taskId)) ?? null)
  ipcMain.handle('enterprise-runners:reassign', (_, taskId: string, runnerId: string) => need().service.reassign(String(taskId), String(runnerId)))
  ipcMain.handle('enterprise-runners:open-locally', (_, taskId: string, opts?: { clone?: boolean }) => need().service.openLocally(String(taskId), { clone: opts?.clone === true }))
  ipcMain.handle('enterprise-runners:list-artifacts', (_, taskId: string) => {
    const rt = getRuntime()
    return rt ? rt.service.listSpacesArtifacts(String(taskId)) : { status: 'signed-out', artifacts: [], syncedAt: null }
  })
  ipcMain.handle('enterprise-runners:read-artifact', (_, taskId: string, id: string) => need().service.readSpacesArtifact(String(taskId), String(id)))
}
