/**
 * Resolves a stored `acp_agent_instances` row into an actually-spawnable
 * `{ command, args, env }`. This is the bridge between DB configuration and
 * the shared ACP client: a local-command instance's executable is used
 * as-is; a registry instance is installed (or reuses a prior validated
 * install) via the install manager, honoring an explicit executable
 * override while always keeping the registry's own args/env.
 */

import type { AcpRegistryIndex } from './registry-types'
import { resolveDistribution, type DistributionKind } from './registry-client'
import type { InstallManager } from './install-manager'

export interface AcpInstanceConfigLike {
  source: 'registry' | 'local'
  registry_agent_id: string | null
  version: string | null
  distribution: 'auto' | 'binary' | 'npx' | 'uvx'
  command_path: string | null
  command_args: string[]
  env: Record<string, string>
}

export interface ResolvedAcpCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

export class AcpInstanceResolutionError extends Error {
  constructor(
    message: string,
    public readonly kind: 'unknown-agent' | 'unknown-version' | 'unsupported-platform' | 'no-distribution' | 'runner-unavailable' | 'missing-local-command'
  ) {
    super(message)
    this.name = 'AcpInstanceResolutionError'
  }
}

/**
 * Resolves a local-command instance: the configured executable, used as-is.
 */
function resolveLocal(instance: AcpInstanceConfigLike): ResolvedAcpCommand {
  if (!instance.command_path) {
    throw new AcpInstanceResolutionError('Local ACP instance has no configured executable', 'missing-local-command')
  }
  return { command: instance.command_path, args: [...instance.command_args], env: { ...instance.env } }
}

/**
 * Resolves a registry-sourced instance: finds the pinned version's entry in
 * the registry index, resolves its distribution for this machine, and
 * installs (or reuses) it. An explicit `command_path` override replaces the
 * resolved executable's path while the registry's own args/env (merged with
 * any instance-level overrides) are always kept.
 */
async function resolveRegistry(
  instance: AcpInstanceConfigLike,
  registryIndex: AcpRegistryIndex,
  installManager: InstallManager
): Promise<ResolvedAcpCommand> {
  const entry = registryIndex.agents.find((a) => a.id === instance.registry_agent_id)
  if (!entry) {
    throw new AcpInstanceResolutionError(`Unknown registry agent id: ${instance.registry_agent_id}`, 'unknown-agent')
  }
  if (instance.version && entry.version !== instance.version) {
    throw new AcpInstanceResolutionError(
      `Registry agent "${entry.id}" is now at version ${entry.version}, but this instance is pinned to ${instance.version}`,
      'unknown-version'
    )
  }

  const preferred: DistributionKind | 'auto' = instance.distribution
  const resolved = await resolveDistribution(entry, { preferred })
  if (!('kind' in resolved) || (resolved.kind !== 'binary' && resolved.kind !== 'npx' && resolved.kind !== 'uvx')) {
    const failure = resolved as { kind: string; message: string }
    const kind =
      failure.kind === 'runner-unavailable'
        ? 'runner-unavailable'
        : failure.kind === 'unsupported-platform'
          ? 'unsupported-platform'
          : 'no-distribution'
    throw new AcpInstanceResolutionError(failure.message, kind)
  }

  const installed = await installManager.ensureInstalled(resolved)
  return {
    command: instance.command_path || installed.executablePath,
    args: [...installed.args, ...instance.command_args],
    env: { ...installed.env, ...instance.env }
  }
}

export async function resolveAcpInstanceCommand(
  instance: AcpInstanceConfigLike,
  deps: { registryIndex: AcpRegistryIndex; installManager: InstallManager }
): Promise<ResolvedAcpCommand> {
  if (instance.source === 'local') return resolveLocal(instance)
  return resolveRegistry(instance, deps.registryIndex, deps.installManager)
}
