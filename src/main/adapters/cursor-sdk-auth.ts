/**
 * Cursor SDK auth plumbing: API-key resolution and a 20x-backed credential
 * store for the browser-login flow.
 *
 * Kept separate from cursor-sdk-adapter.ts because none of this needs the
 * (dynamically-imported, ESM-only) `@cursor/sdk` runtime value — only its
 * types, which are erased at compile time, so this file has zero load-order
 * dependency on the adapter's lazy SDK import.
 */

import { safeStorage } from 'electron'
import type { SdkCredentialStore, StoredSdkCredentials } from '@cursor/sdk'
import type { DatabaseManager } from '../database'
import type { SessionConfig } from './coding-agent-adapter'

/** Settings-table key the encrypted browser-login credential blob is stored under. */
export const CURSOR_SDK_CREDENTIALS_SETTING_KEY = 'cursor-sdk-credentials'

type CredentialDb = Pick<DatabaseManager, 'getSetting' | 'setSetting' | 'deleteSetting'>

/**
 * Validates an untrusted parsed JSON value against the `StoredSdkCredentials`
 * shape. The SDK ships an equivalent `parseStoredSdkCredentials` internally
 * (see `auth/credential-store.d.ts`), but it is not re-exported through the
 * package's public `exports` map in this pinned version (1.0.37) — only `.`
 * and `./sqlite` are. This is a straightforward reimplementation of the same
 * contract: anything foreign-shaped or corrupt loads as "logged out" rather
 * than throwing.
 */
export function parseStoredCursorCredentials(value: unknown): StoredSdkCredentials | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1) return undefined
  if (typeof candidate.backendUrl !== 'string' || !candidate.backendUrl) return undefined
  if (typeof candidate.apiKey !== 'string' || !candidate.apiKey) return undefined
  if (typeof candidate.createdAtMs !== 'number') return undefined
  if (candidate.apiKeyExpiresAtMs !== undefined && typeof candidate.apiKeyExpiresAtMs !== 'number') return undefined
  if (candidate.email !== undefined && typeof candidate.email !== 'string') return undefined
  return {
    version: 1,
    backendUrl: candidate.backendUrl,
    apiKey: candidate.apiKey,
    createdAtMs: candidate.createdAtMs,
    ...(candidate.apiKeyExpiresAtMs !== undefined ? { apiKeyExpiresAtMs: candidate.apiKeyExpiresAtMs as number } : {}),
    ...(candidate.email !== undefined ? { email: candidate.email as string } : {})
  }
}

/**
 * Persists the SDK browser-login credential (a single JSON blob: API key +
 * expiry + email) using 20x's own `safeStorage`-encrypted settings row —
 * the same primitive the `secrets` table uses for user-managed secrets,
 * applied directly to a dedicated settings key instead of inserting a
 * synthetic row into the user-facing secrets list (which expects a
 * name/env-var-name pair a human manages, not an internal OAuth-shaped
 * blob this adapter owns end-to-end).
 */
export class DbSdkCredentialStore implements SdkCredentialStore {
  constructor(private readonly db: CredentialDb) {}

  async load(): Promise<StoredSdkCredentials | undefined> {
    const raw = this.db.getSetting(CURSOR_SDK_CREDENTIALS_SETTING_KEY)
    if (!raw) return undefined
    try {
      const buffer = Buffer.from(raw, 'base64')
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buffer) : buffer.toString('utf8')
      return parseStoredCursorCredentials(JSON.parse(json))
    } catch {
      // Corrupt or foreign-shaped value: treat as logged out, never throw.
      return undefined
    }
  }

  async save(credentials: StoredSdkCredentials): Promise<void> {
    const json = JSON.stringify(credentials)
    const buffer = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8')
    this.db.setSetting(CURSOR_SDK_CREDENTIALS_SETTING_KEY, buffer.toString('base64'))
  }

  async clear(): Promise<void> {
    this.db.deleteSetting(CURSOR_SDK_CREDENTIALS_SETTING_KEY)
  }
}

/** Thrown when API-key auth is requested but no key is configured anywhere. */
export class CursorApiKeyMissingError extends Error {
  constructor() {
    super('Cursor API-key authentication requires a configured key or CURSOR_API_KEY')
    this.name = 'CursorApiKeyMissingError'
  }
}

/**
 * Resolves the API key to use for one Cursor SDK call, mirroring the
 * precedence the pre-refactor ACP shim's `configureCursorAuthEnv` used
 * (see `git log` on `acp-adapter.ts` before commit 79c412d6):
 *
 *  - `authMethod === 'api_key'` (or an explicit key is configured and
 *    `authMethod` isn't `'subscription'`): use `config.apiKeys.cursor`,
 *    falling back to `CURSOR_API_KEY`. Missing key is an error — API-key
 *    mode must not silently fall through to a different identity.
 *  - Otherwise ("subscription" / default): the browser-login credential
 *    this adapter's own store persisted is authoritative. Ambient
 *    `CURSOR_API_KEY` is deliberately NOT consulted here, so it can't
 *    silently switch billing/authentication away from the logged-in
 *    account.
 *
 * Returns `undefined` when subscription mode has no stored login yet (the
 * SDK call will then throw `AuthenticationError`, which is the correct,
 * actionable failure).
 */
export async function resolveCursorApiKey(
  config: Pick<SessionConfig, 'apiKeys' | 'authMethod'> | undefined,
  store: SdkCredentialStore
): Promise<string | undefined> {
  const explicitApiKey = config?.apiKeys?.cursor
  const useApiKey = config?.authMethod === 'api_key' || (config?.authMethod !== 'subscription' && !!explicitApiKey)

  if (useApiKey) {
    const key = explicitApiKey || process.env.CURSOR_API_KEY
    if (!key) throw new CursorApiKeyMissingError()
    return key
  }

  const stored = await store.load()
  if (!stored) return undefined
  if (stored.apiKeyExpiresAtMs && stored.apiKeyExpiresAtMs <= Date.now()) return undefined
  return stored.apiKey
}

/** True when API-key auth is configured — used to refuse browser login/logout while a key is set. */
export function hasExplicitApiKey(config: Pick<SessionConfig, 'apiKeys' | 'authMethod'> | undefined): boolean {
  if (config?.authMethod === 'api_key') return true
  return config?.authMethod !== 'subscription' && !!config?.apiKeys?.cursor
}
