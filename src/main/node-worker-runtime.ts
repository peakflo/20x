/** Runtime for standalone scripts. macOS packages do not expose Electron as Node. */
export function nodeWorkerRuntime(
  platform: NodeJS.Platform = process.platform,
  executable: string = process.execPath,
  environment: NodeJS.ProcessEnv = process.env,
): { execPath: string; env: NodeJS.ProcessEnv } {
  const env = { ...environment }
  if (platform === 'darwin') {
    delete env.ELECTRON_RUN_AS_NODE
    return { execPath: 'node', env }
  }
  return { execPath: executable, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
}
