/**
 * Process-wide singletons for the ACP registry client and install manager,
 * rooted at `<userData>/acp-agents`. Lazily constructed so importing this
 * module never touches `app.getPath` before Electron is ready (tests can
 * also just never call these getters).
 */

import { app } from 'electron'
import { join } from 'path'
import { createRegistryClient, type RegistryLoadResult } from './registry-client'
import { InstallManager } from './install-manager'

let registryClient: ReturnType<typeof createRegistryClient> | null = null
let installManager: InstallManager | null = null

export function acpAgentsRootDir(): string {
  return join(app.getPath('userData'), 'acp-agents')
}

export function getAcpRegistryClient(): ReturnType<typeof createRegistryClient> {
  if (!registryClient) {
    registryClient = createRegistryClient({ cacheDir: acpAgentsRootDir() })
  }
  return registryClient
}

export function getAcpInstallManager(): InstallManager {
  if (!installManager) {
    installManager = new InstallManager({ rootDir: acpAgentsRootDir() })
  }
  return installManager
}

/** Test-only: force both singletons to be rebuilt on next access. */
export function __resetAcpRuntimeForTests(): void {
  registryClient = null
  installManager = null
}

export type { RegistryLoadResult }
