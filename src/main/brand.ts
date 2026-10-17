export const STORED_ORGANISATION_WORKSPACE_NAME = '[Workflo] Organisation Workspace'

let selectedCompanyBrand: boolean | null = null
const brandChangedListeners = new Set<(enabled: boolean) => void>()

export function onBrandSpacesChanged(listener: (enabled: boolean) => void): () => void {
  brandChangedListeners.add(listener)
  return () => brandChangedListeners.delete(listener)
}

/** The authenticated company value is saved by EnterpriseAuth. */
export function setSelectedCompanyBrand(value: boolean | null): void {
  const previous = brandSpacesEnabled()
  selectedCompanyBrand = value
  const current = brandSpacesEnabled()
  if (current !== previous) {
    for (const listener of brandChangedListeners) listener(current)
  }
}

/** An explicit environment value can override the selected company for rollout. */
export function brandSpacesEnabled(): boolean {
  if (process.env.BRAND_SPACES === 'true') return true
  if (process.env.BRAND_SPACES === 'false') return false
  return selectedCompanyBrand === true
}

export function desktopBrandName(legacyName = 'Workflo'): string {
  return brandSpacesEnabled() ? 'Spaces' : legacyName
}

export function organisationWorkspaceName(): string {
  return `[${desktopBrandName()}] Organisation Workspace`
}

/** Change presentation only. The saved row and runtime key stay stable. */
export function displayMcpServerName(server: { name: string; source?: string }): string {
  return server.source === 'enterprise' && server.name === STORED_ORGANISATION_WORKSPACE_NAME
    ? organisationWorkspaceName()
    : server.name
}

/** The adapter key is part of saved tool names and must stay stable. */
export function mcpRuntimeName(server: { name: string; source?: string }): string {
  return server.source === 'enterprise' && server.name === '[Spaces] Organisation Workspace'
    ? STORED_ORGANISATION_WORKSPACE_NAME
    : server.name
}

export function findStoredWorkspaceServer<T extends { name: string; source?: string }>(
  servers: T[]
): T | undefined {
  return servers.find((server) => server.name === STORED_ORGANISATION_WORKSPACE_NAME)
    ?? servers.find((server) => server.name === '[Spaces] Organisation Workspace' && server.source === 'enterprise')
    ?? servers.find((server) => server.name === '[Workflo] MCP Dev Server' && server.source === 'enterprise')
}
