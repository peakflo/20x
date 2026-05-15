/**
 * Utilities for reading OpenCode configuration and auth files,
 * and merging auth keys into provider configs so custom providers
 * (e.g. routerAI) are correctly authenticated when the server starts.
 *
 * The OpenCode server reads `opencode.json` for provider definitions but
 * does NOT automatically merge API keys from `auth.json` into custom
 * config-based providers.  When we spawn the server we pass the merged
 * config via `OPENCODE_CONFIG_CONTENT` so every provider has its key.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { DatabaseManager } from '../database'
import {
  buildEnterpriseAiGatewayProviderConfig,
  readEnterpriseAiGatewayConfig
} from '../enterprise-ai-gateway'

/** Paths used by the OpenCode CLI to store config & auth. */
const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json')
const OPENCODE_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json')

export interface OpencodeAuthEntry {
  type: string
  key?: string
  refresh?: string
  access?: string
  expires?: number
}

/**
 * Reads the user's `~/.config/opencode/opencode.json`.
 * Returns the parsed object or an empty object on any failure.
 */
export function readOpencodeConfig(): Record<string, unknown> {
  try {
    if (existsSync(OPENCODE_CONFIG_PATH)) {
      return JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, 'utf-8'))
    }
  } catch (e) {
    console.log('[opencode-config] Could not read opencode.json:', e)
  }
  return {}
}

/**
 * Reads the user's `~/.local/share/opencode/auth.json`.
 * Returns a map of provider-id -> auth entry, or empty on failure.
 */
export function readOpencodeAuth(): Record<string, OpencodeAuthEntry> {
  try {
    if (existsSync(OPENCODE_AUTH_PATH)) {
      return JSON.parse(readFileSync(OPENCODE_AUTH_PATH, 'utf-8'))
    }
  } catch (e) {
    console.log('[opencode-config] Could not read auth.json:', e)
  }
  return {}
}

/**
 * Builds a complete config object suitable for `OPENCODE_CONFIG_CONTENT`.
 *
 * 1. Reads the user's `opencode.json`
 * 2. Reads `auth.json`
 * 3. For every provider defined in the config that has a matching auth entry
 *    but no `apiKey` in its options, injects the key from auth.json.
 * 4. Merges any `extraConfig` on top (e.g. plugin paths from the adapter).
 *
 * This ensures custom providers like routerAI — whose API key lives only
 * in auth.json — are included by the server in its `/config/providers` response.
 */
export function buildMergedOpencodeConfig(
  extraConfig?: Record<string, unknown>,
  db?: Pick<DatabaseManager, 'getSetting'>
): Record<string, unknown> {
  const config = readOpencodeConfig()
  const auth = readOpencodeAuth()

  // Inject auth keys into providers that lack an inline apiKey
  const providers = config.provider as Record<string, Record<string, unknown>> | undefined
  if (providers && typeof providers === 'object') {
    for (const [providerId, providerCfg] of Object.entries(providers)) {
      if (!providerCfg || typeof providerCfg !== 'object') continue

      const options = (providerCfg.options ?? {}) as Record<string, unknown>

      // Skip if the provider already has an apiKey in its options
      if (options.apiKey) continue

      // Check auth.json for a matching key
      const authEntry = auth[providerId]
      if (authEntry?.key) {
        providerCfg.options = { ...options, apiKey: authEntry.key }
        console.log(`[opencode-config] Injected API key for provider "${providerId}" from auth.json`)
      }
    }
  }

  const enterpriseAiGatewayConfig = db
    ? readEnterpriseAiGatewayConfig(db)
    : null
  if (enterpriseAiGatewayConfig) {
    const existingProviders =
      (config.provider as Record<string, unknown> | undefined) ?? {}
    config.provider = {
      ...existingProviders,
      ...buildEnterpriseAiGatewayProviderConfig(enterpriseAiGatewayConfig)
    }
  }

  // Merge extra config (e.g. plugin paths) on top
  if (extraConfig) {
    for (const [key, value] of Object.entries(extraConfig)) {
      if (value !== undefined) {
        config[key] = value
      }
    }
  }

  return config
}
