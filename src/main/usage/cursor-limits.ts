/**
 * Cursor subscription plan limits.
 *
 * Reads the current billing period's plan usage from Cursor's dashboard API
 * with the Cursor CLI login token (`cursor-agent login`).
 *
 * Token sources, in order:
 * 1. `CURSOR_AUTH_TOKEN`
 * 2. the CLI's file-based login (`auth.json` → `accessToken`)
 * 3. macOS Keychain (`cursor-access-token` / `cursor-user`) — opt-in only,
 *    because reading another app's Keychain item can show a system prompt.
 */

import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ProviderUsageLimits } from '../../shared/usage'
import { cursorPeriodUsageToLimits } from './usage-normalize'

export const CURSOR_KEYCHAIN_ACCESS_SETTING = 'usage.cursorKeychainAccess'
export const ENABLE_CURSOR_KEYCHAIN_ACTION = 'enable-cursor-keychain'

const CURSOR_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const REQUEST_TIMEOUT_MS = 10_000

export function cursorAuthFilePath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') return join(homedir(), '.cursor', 'auth.json')
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'auth.json')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cursor', 'auth.json')
}

function readTokenFromAuthFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { accessToken?: unknown }
    return typeof parsed.accessToken === 'string' && parsed.accessToken.trim() ? parsed.accessToken.trim() : null
  } catch {
    return null
  }
}

function readTokenFromKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'],
      { timeout: 30_000 },
      (error, stdout) => {
        const token = typeof stdout === 'string' ? stdout.trim() : ''
        resolve(error || !token ? null : token)
      }
    )
  })
}

export interface CursorLimitsOptions {
  /** Whether the user allowed reading the Cursor CLI login from the macOS Keychain. */
  allowKeychain: boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  readKeychain?: () => Promise<string | null>
}

export async function resolveCursorAuthToken(options: CursorLimitsOptions): Promise<{ token: string | null; keychainAvailable: boolean }> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const fromEnv = env.CURSOR_AUTH_TOKEN?.trim()
  if (fromEnv) return { token: fromEnv, keychainAvailable: false }
  const fromFile = readTokenFromAuthFile(cursorAuthFilePath(platform, env))
  if (fromFile) return { token: fromFile, keychainAvailable: false }
  if (platform !== 'darwin') return { token: null, keychainAvailable: false }
  if (!options.allowKeychain) return { token: null, keychainAvailable: true }
  const fromKeychain = await (options.readKeychain ?? readTokenFromKeychain)()
  return { token: fromKeychain, keychainAvailable: true }
}

export async function probeCursorUsageLimits(options: CursorLimitsOptions): Promise<ProviderUsageLimits | null> {
  const checkedAt = new Date().toISOString()
  const { token, keychainAvailable } = await resolveCursorAuthToken(options)

  if (!token) {
    if (keychainAvailable && !options.allowKeychain) {
      return {
        provider: 'cursor',
        checkedAt,
        windows: [],
        unavailable: {
          reason: 'unsupported',
          message: 'Cursor keeps its CLI login in the macOS Keychain. Allow access to show your Cursor plan usage.'
        },
        action: { id: ENABLE_CURSOR_KEYCHAIN_ACTION, label: 'Allow Keychain access' }
      }
    }
    // Not logged in with the Cursor CLI (or API-key only): plan limits do not apply.
    return keychainAvailable
      ? {
        provider: 'cursor',
        checkedAt,
        windows: [],
        unavailable: { reason: 'unsupported', message: 'No Cursor CLI login found. Run `cursor-agent login` to show plan usage.' }
      }
      : null
  }

  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(CURSOR_USAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'connect-protocol-version': '1',
        'x-cursor-client-type': 'cli'
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (response.status === 401 || response.status === 403) {
      return {
        provider: 'cursor', checkedAt, windows: [],
        unavailable: { reason: 'unsupported', message: 'The Cursor CLI login was rejected. Run `cursor-agent login` again.' }
      }
    }
    if (!response.ok) {
      return {
        provider: 'cursor', checkedAt, windows: [],
        unavailable: { reason: 'probe_failed', message: `Cursor usage request failed (HTTP ${response.status})` }
      }
    }
    return cursorPeriodUsageToLimits(await response.json(), checkedAt)
  } catch (error) {
    return {
      provider: 'cursor', checkedAt, windows: [],
      unavailable: { reason: 'probe_failed', message: error instanceof Error ? error.message : String(error) }
    }
  }
}
