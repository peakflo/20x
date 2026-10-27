import { execFile } from 'child_process'
import { basename, dirname, isAbsolute } from 'path'

/** pnpm prints a versioned path such as /Users/me/Library/pnpm/store/v3. */
export function pnpmStoreRoot(output: string): string | null {
  const versionedPath = output.trim().split(/\r?\n/).pop()?.trim()
  if (!versionedPath || !isAbsolute(versionedPath) || !/^v\d+$/.test(basename(versionedPath))) return null
  return dirname(versionedPath)
}

/** Make agent-launched pnpm installs use the user's existing store on this disk. */
export async function configureSharedPnpmStore(userDataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.npm_config_store_dir || env.NPM_CONFIG_STORE_DIR) {
    return env.npm_config_store_dir || env.NPM_CONFIG_STORE_DIR || null
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('pnpm', ['store', 'path'], {
        cwd: userDataDir,
        env,
        timeout: 5000,
        windowsHide: true,
        shell: process.platform === 'win32'
      }, (error, output) => error ? reject(error) : resolve(output))
    })
    const root = pnpmStoreRoot(stdout)
    if (!root) return null
    env.npm_config_store_dir = root
    return root
  } catch (error) {
    console.warn('[Main] Could not resolve the shared pnpm store; pnpm will use its own default:', error)
    return null
  }
}
