/** The desktop process uses the same deployment flag as the web application. */
export function brandSpacesEnabled(): boolean {
  return process.env.BRAND_SPACES === 'true'
}

export function desktopBrandName(legacyName = 'Workflo'): string {
  return brandSpacesEnabled() ? 'Spaces' : legacyName
}

export function organisationWorkspaceName(): string {
  return `[${desktopBrandName()}] Organisation Workspace`
}

/** The adapter key is part of saved tool names and must stay stable. */
export function mcpRuntimeName(server: { name: string; source?: string }): string {
  return server.source === 'enterprise' && server.name === '[Spaces] Organisation Workspace'
    ? '[Workflo] Organisation Workspace'
    : server.name
}
