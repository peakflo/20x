import { readdirSync } from 'fs'
import { win32 } from 'path'

function normalizeWindowsPathSegment(entry: string): string {
  return entry.replace(/[\\/]+$/, '').toLowerCase()
}

function getDiscoveredPythonPaths(localAppData: string): string[] {
  const pythonRoot = win32.join(localAppData, 'Programs', 'Python')

  try {
    return readdirSync(pythonRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
      .map((entry) => win32.join(pythonRoot, entry.name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
      .flatMap((pythonDir) => [pythonDir, win32.join(pythonDir, 'Scripts')])
  } catch {
    return []
  }
}

export function getWindowsPathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE || env.HOME || ''
  const localAppData = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')

  return [
    win32.join(home, 'AppData', 'Roaming', 'npm'),
    'C:\\Program Files\\nodejs',
    'C:\\Program Files\\Git\\cmd',
    ...getDiscoveredPythonPaths(localAppData)
  ]
}

export function prependMissingWindowsPaths(existingPath: string, candidates: string[]): string {
  const existingEntries = existingPath.split(';').filter(Boolean)
  const existingSet = new Set(existingEntries.map(normalizeWindowsPathSegment))
  const missingEntries = candidates.filter((candidate) => {
    if (!candidate) return false
    return !existingSet.has(normalizeWindowsPathSegment(candidate))
  })

  return [...missingEntries, ...existingEntries].join(';')
}
