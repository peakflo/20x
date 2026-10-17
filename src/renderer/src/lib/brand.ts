/** The preload reads the same runtime flag as the main process. */
export function desktopBrandName(
  legacyName = 'Workflo',
  enabled = typeof window !== 'undefined' && (window.electronAPI?.app?.brandSpacesEnabled?.() ?? false)
): string {
  return enabled ? 'Spaces' : legacyName
}
