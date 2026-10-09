import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { InstallManager } from './install-manager'
import { AcpInstanceResolutionError, resolveAcpInstanceCommand, type AcpInstanceConfigLike } from './resolve-instance'
import type { AcpRegistryIndex } from './registry-types'

const registryIndex: AcpRegistryIndex = {
  version: '1.0.0',
  agents: [
    {
      id: 'devin',
      name: 'Devin',
      version: '1.2.3',
      distribution: {
        binary: { 'darwin-aarch64': { archive: 'https://example.com/devin.tar.gz', cmd: './devin' } },
        npx: { package: 'devin-acp@1.2.3' }
      }
    }
  ]
}

describe('resolveAcpInstanceCommand: local', () => {
  it('uses the configured executable as-is', async () => {
    const instance: AcpInstanceConfigLike = {
      source: 'local',
      registry_agent_id: null,
      version: null,
      distribution: 'auto',
      command_path: '/usr/local/bin/my-agent',
      command_args: ['--flag'],
      env: { FOO: 'bar' }
    }
    const resolved = await resolveAcpInstanceCommand(instance, {
      registryIndex,
      installManager: new InstallManager({ rootDir: '/unused' })
    })
    expect(resolved).toEqual({ command: '/usr/local/bin/my-agent', args: ['--flag'], env: { FOO: 'bar' } })
  })

  it('throws missing-local-command when no executable is configured', async () => {
    const instance: AcpInstanceConfigLike = {
      source: 'local',
      registry_agent_id: null,
      version: null,
      distribution: 'auto',
      command_path: null,
      command_args: [],
      env: {}
    }
    await expect(
      resolveAcpInstanceCommand(instance, { registryIndex, installManager: new InstallManager({ rootDir: '/unused' }) })
    ).rejects.toMatchObject({ kind: 'missing-local-command' })
  })
})

describe('resolveAcpInstanceCommand: registry', () => {
  let rootDir: string
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'acp-resolve-'))
  })
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  function manager(): InstallManager {
    return new InstallManager({
      rootDir,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        body: {
          getReader() {
            let sent = false
            return {
              async read() {
                if (sent) return { done: true, value: undefined }
                sent = true
                return { done: false, value: new Uint8Array(Buffer.from('fake')) }
              }
            }
          }
        }
      })) as unknown as typeof fetch,
      listArchiveEntries: async () => [{ path: 'devin', isSymlink: false }],
      extractArchive: async (_p, destDir) => {
        await writeFile(join(destDir, 'devin'), '#!/bin/sh\n')
        await chmod(join(destDir, 'devin'), 0o755)
      }
    })
  }

  it('installs and resolves a registry instance with no override', async () => {
    const instance: AcpInstanceConfigLike = {
      source: 'registry',
      registry_agent_id: 'devin',
      version: '1.2.3',
      distribution: 'binary',
      command_path: null,
      command_args: [],
      env: {}
    }
    // Pinned so this binary-distribution fixture resolves the same way on
    // every CI platform (it only declares a darwin-aarch64 target), not just
    // whatever machine happens to run the test.
    const resolved = await resolveAcpInstanceCommand(instance, {
      registryIndex,
      installManager: manager(),
      platformTarget: 'darwin-aarch64'
    })
    expect(resolved.command).toContain('devin')
  })

  it('an executable override replaces the path but keeps the resolved args/env, merged with instance overrides', async () => {
    const instance: AcpInstanceConfigLike = {
      source: 'registry',
      registry_agent_id: 'devin',
      version: '1.2.3',
      distribution: 'binary',
      command_path: '/opt/custom/devin-override',
      command_args: ['--extra'],
      env: { MY_VAR: '1' }
    }
    const resolved = await resolveAcpInstanceCommand(instance, {
      registryIndex,
      installManager: manager(),
      platformTarget: 'darwin-aarch64'
    })
    expect(resolved.command).toBe('/opt/custom/devin-override')
    expect(resolved.args).toEqual(['--extra'])
    expect(resolved.env).toEqual({ MY_VAR: '1' })
  })

  it('throws unknown-agent for a registry_agent_id not present in the index', async () => {
    const instance: AcpInstanceConfigLike = {
      source: 'registry',
      registry_agent_id: 'does-not-exist',
      version: null,
      distribution: 'auto',
      command_path: null,
      command_args: [],
      env: {}
    }
    await expect(resolveAcpInstanceCommand(instance, { registryIndex, installManager: manager() })).rejects.toSatisfy(
      (e: unknown) => e instanceof AcpInstanceResolutionError && e.kind === 'unknown-agent'
    )
  })

  it('throws unknown-version when the instance is pinned to a version the registry no longer serves', async () => {
    const instance: AcpInstanceConfigLike = {
      source: 'registry',
      registry_agent_id: 'devin',
      version: '0.0.1',
      distribution: 'auto',
      command_path: null,
      command_args: [],
      env: {}
    }
    await expect(resolveAcpInstanceCommand(instance, { registryIndex, installManager: manager() })).rejects.toSatisfy(
      (e: unknown) => e instanceof AcpInstanceResolutionError && e.kind === 'unknown-version'
    )
  })

  it('throws no-distribution when the forced distribution kind is not declared by the entry', async () => {
    const instance: AcpInstanceConfigLike = {
      source: 'registry',
      registry_agent_id: 'devin',
      version: '1.2.3',
      distribution: 'uvx',
      command_path: null,
      command_args: [],
      env: {}
    }
    await expect(resolveAcpInstanceCommand(instance, { registryIndex, installManager: manager() })).rejects.toSatisfy(
      (e: unknown) => e instanceof AcpInstanceResolutionError && e.kind === 'no-distribution'
    )
  })
})
