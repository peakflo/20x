/**
 * Renderer-facing types for ACP (Agent Client Protocol) registry search and
 * configured agent instances. Mirrors the main-process DB/registry shapes
 * without pulling any Node-only code into the renderer bundle.
 */

export type AcpInstanceSource = 'registry' | 'local'
export type AcpInstanceDistribution = 'auto' | 'binary' | 'npx' | 'uvx'

/** One registry search result, already platform-filtered for "can this be installed here." */
export interface AcpRegistrySearchResult {
  id: string
  name: string
  description: string | null
  version: string
  license: string | null
  licenseUrl: string | null
  repository: string | null
  website: string | null
  icon: string | null
  /** False when no distribution the registry declares is usable on this machine (missing runner, unsupported platform). */
  installableHere: boolean
}

/** A configured ACP agent instance, as shown in Settings → Agents. */
export interface AcpAgentInstanceView {
  id: string
  display_name: string
  source: AcpInstanceSource
  registry_agent_id: string | null
  version: string | null
  distribution: AcpInstanceDistribution
  command_path: string | null
  command_args: string[]
  env: Record<string, string>
  secret_ids: string[]
  auth_method_id: string | null
  custom_models: string[]
  created_at: string
}

export interface CreateAcpAgentInstanceDTO {
  display_name: string
  source: AcpInstanceSource
  registry_agent_id?: string | null
  version?: string | null
  distribution?: AcpInstanceDistribution
  command_path?: string | null
  command_args?: string[]
  env?: Record<string, string>
  secret_ids?: string[]
  auth_method_id?: string | null
  custom_models?: string[]
}

export interface UpdateAcpAgentInstanceDTO {
  display_name?: string
  command_path?: string | null
  command_args?: string[]
  env?: Record<string, string>
  secret_ids?: string[]
  auth_method_id?: string | null
  custom_models?: string[]
}

export type AcpInstallResult = { ok: true; command: string } | { ok: false; error: string }

export type LocalCommandValidationResult =
  | { ok: true }
  | { ok: false; kind: 'empty-executable' | 'windows-script-wrapper' | 'not-found' | 'not-executable'; message: string }
