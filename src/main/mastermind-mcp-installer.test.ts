import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MastermindMcpStatus } from '../shared/mastermind-mcp'
import { installedSkillState, MastermindMcpInstaller } from './mastermind-mcp-installer'

const bundled = '---\nmetadata:\n  version: "2"\n---\nUse Mastermind.\n'
const homes: string[] = []
const fakeStatus = { enabled: false, running: false, url: '', skillVersion: '2', clients: {} } as MastermindMcpStatus

afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Mastermind MCP skill version', () => {
  it('distinguishes missing, current, outdated, modified, and unavailable skills', () => {
    expect(installedSkillState(undefined, bundled)).toEqual({ state: 'not_installed' })
    expect(installedSkillState(bundled, bundled)).toEqual({ state: 'current', version: '2' })
    expect(installedSkillState(bundled.replace('version: "2"', 'version: "1"'), bundled)).toEqual({ state: 'outdated', version: '1' })
    expect(installedSkillState(`${bundled}local change\n`, bundled)).toEqual({ state: 'modified', version: '2' })
    expect(installedSkillState(bundled, bundled, false)).toEqual({ state: 'client_unavailable' })
  })

  it('preserves unrelated Pi configuration and is idempotent', async () => {
    const home = await mkdtemp(join(tmpdir(), '20x-mcp-installer-')); homes.push(home)
    const configPath = join(home, '.pi', 'agent', 'mcp.json')
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, JSON.stringify({ theme: 'dark', mcpServers: { other: { url: 'http://other.test' } } }))
    const run = vi.fn(async () => ({ stdout: 'pi-mcp-adapter', stderr: '' })) as unknown as ConstructorParameters<typeof MastermindMcpInstaller>[1]
    const installer = new MastermindMcpInstaller(home, run, bundled)

    const first = await installer.install('pi', async () => fakeStatus)
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    expect(config).toMatchObject({ theme: 'dark', mcpServers: { other: { url: 'http://other.test' }, '20x': { url: 'http://127.0.0.1:20621/mcp' } } })
    expect(first.changedPaths).toContain(configPath)
    expect(first.backupPaths).toHaveLength(1)
    expect((await installer.install('pi', async () => fakeStatus)).changedPaths).toEqual([])
  })

  it('refuses to overwrite malformed Pi configuration', async () => {
    const home = await mkdtemp(join(tmpdir(), '20x-mcp-installer-')); homes.push(home)
    const configPath = join(home, '.pi', 'agent', 'mcp.json')
    await mkdir(dirname(configPath), { recursive: true }); await writeFile(configPath, 'not-json')
    const run = vi.fn(async () => ({ stdout: 'pi-mcp-adapter', stderr: '' })) as unknown as ConstructorParameters<typeof MastermindMcpInstaller>[1]
    await expect(new MastermindMcpInstaller(home, run, bundled).install('pi', async () => fakeStatus)).rejects.toThrow('Cannot update')
    expect(await readFile(configPath, 'utf8')).toBe('not-json')
  })
})
