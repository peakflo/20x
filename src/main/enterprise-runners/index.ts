import { execFile, spawn } from 'node:child_process'
import { homedir, hostname, platform as osPlatform, arch as osArch, release } from 'node:os'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, shell } from 'electron'
import {
  buildUninstallPlan,
  type UninstallPlan,
  type ConnectProgress,
  type MachineActionResult,
  type MachinesResult,
  type PreflightResult,
  type StartConnectRequest,
  type StartConnectResult
} from '../../shared/enterprise-runners'
import type { EnterpriseAuth } from '../enterprise-auth'
import { EnterpriseRunnersApi, type EnterpriseRequester } from './api-client'
import { ConnectRunner } from './connect-runner'
import { createCommandRunner, runPreflight } from './preflight'
import { resolveToolchain } from './toolchain'

export { EnterpriseRunnersApi } from './api-client'
export type { EnterpriseRequester } from './api-client'

/** Adapt the app's enterprise session to the small interface this module uses. */
export function requesterFromAuth(auth: EnterpriseAuth): EnterpriseRequester {
  return {
    apiRequest: (method, path, body) => auth.apiRequest(method, path, body),
    getApiUrl: () => auth.getApiUrl(),
    getIdentity: async () => {
      try {
        const session = await auth.getSession()
        return session.isAuthenticated && session.userId && session.currentTenant
          ? { tenantId: session.currentTenant.id, userId: session.userId }
          : null
      } catch {
        return null
      }
    },
    isSignedIn: async () => {
      try {
        const session = await auth.getSession()
        return session.isAuthenticated && session.currentTenant !== null
      } catch {
        return false
      }
    }
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

let activeRunner: ConnectRunner | null = null

/** Stop a running connect command. Called from the app's before-quit handler. */
export function shutdownEnterpriseRunners(): void {
  activeRunner?.shutdown()
}

export interface EnterpriseRunnersService {
  api: EnterpriseRunnersApi
  listMachines(): Promise<MachinesResult>
}

/**
 * Register the `enterprise-runners:*` IPC surface. Returns the service so the
 * mobile API can serve the same read-only list.
 */
export function registerEnterpriseRunnersIpc(auth: EnterpriseAuth | undefined): EnterpriseRunnersService | null {
  if (!auth) return null
  const requester = requesterFromAuth(auth)
  const api = new EnterpriseRunnersApi(requester)
  const runCommand = createCommandRunner(execFile)

  const runner: ConnectRunner = new ConnectRunner({
    api,
    spawn: (command, args, options) => spawn(command, args as string[], options),
    platform: osPlatform(),
    openExternal: (url) => shell.openExternal(url),
    onProgress: (progress) => broadcast('enterprise-runners:connect-progress', progress),
    onConnected: () => broadcast('enterprise-runners:machines-changed', null),
    newId: randomUUID,
    resolveToolchain: (env) => resolveToolchain(env),
    cwd: homedir(),
    computerInstance: () => api.getComputerInstance(),
    // Already redacted by the parser; never log raw child output.
    log: (message) => console.log(message)
  })

  activeRunner = runner

  const listMachines = (): Promise<MachinesResult> => api.listMachines(hostname())

  ipcMain.handle('enterprise-runners:list', (): Promise<MachinesResult> => listMachines())
  ipcMain.handle(
    'enterprise-runners:rename',
    async (_, runnerId: string, name: string): Promise<MachineActionResult> => api.renameMachine(String(runnerId), String(name))
  )
  ipcMain.handle(
    'enterprise-runners:remove',
    async (_, runnerId: string): Promise<MachineActionResult & { uninstall?: UninstallPlan }> => {
      const before = await listMachines()
      const machine = before.ok ? before.snapshot.machines.find((m) => m.id === runnerId) : undefined
      const version = before.ok ? (before.snapshot.pinnedVersion ?? machine?.version ?? null) : null
      const result = await api.removeMachine(String(runnerId))
      return result.ok ? { ...result, uninstall: buildUninstallPlan(version, machine?.serviceInstances ?? []) } : result
    }
  )
  ipcMain.handle('enterprise-runners:update', (_, runnerId: string): Promise<MachineActionResult> => api.updateMachine(String(runnerId)))
  ipcMain.handle('enterprise-runners:preflight', async (): Promise<PreflightResult> =>
    runPreflight({
      toolchain: resolveToolchain(process.env),
      platform: osPlatform(),
      arch: osArch(),
      osVersion: osPlatform() === 'darwin' ? undefined : release(),
      run: runCommand,
      api,
      isSignedIn: requester.isSignedIn
    })
  )
  ipcMain.handle(
    'enterprise-runners:connect-start',
    (_, request: StartConnectRequest): Promise<StartConnectResult> =>
      runner.start({
        vendor: ['all', 'claude-code', 'codex', 'cursor'].includes(request?.vendor) ? request.vendor : 'all',
        ask: request?.ask === true,
        ...(typeof request?.replacesRunnerId === 'string' ? { replacesRunnerId: request.replacesRunnerId } : {})
      })
  )
  ipcMain.handle('enterprise-runners:connect-cancel', (_, runId?: string): void => runner.cancel(runId))
  ipcMain.handle('enterprise-runners:connect-progress', (_, runId?: string): ConnectProgress | null => runner.getProgress(runId))
  ipcMain.handle('enterprise-runners:open-approval', (_, runId: string): Promise<boolean> => runner.openApprovalPage(String(runId)))

  return { api, listMachines }
}
