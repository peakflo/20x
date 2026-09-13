import { app } from 'electron'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  MASTERMIND_MCP_SKILL_VERSION, MASTERMIND_MCP_URL,
  type MastermindMcpClient, type MastermindMcpClientStatus,
  type MastermindMcpInstallResult, type MastermindMcpSkillState
} from '../shared/mastermind-mcp'

const execFile = promisify(execFileCallback)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)
const versionOf = (content: string): string | undefined => content.match(/^\s*version:\s*["']?([^\s"']+)/m)?.[1]

export function installedSkillState(content: string | undefined, bundled: string, available = true): { state: MastermindMcpSkillState; version?: string } {
  if (!available) return { state: 'client_unavailable' }
  if (content === undefined) return { state: 'not_installed' }
  const version = versionOf(content)
  if (version !== MASTERMIND_MCP_SKILL_VERSION) return { state: 'outdated', ...(version ? { version } : {}) }
  return { state: hash(content) === hash(bundled) ? 'current' : 'modified', version }
}

export class MastermindMcpInstaller {
  constructor(private readonly home = homedir(), private readonly run = execFile, private readonly bundledOverride?: string) {}

  private piDir(): string { return join(this.home, '.pi', 'agent') }
  private skillPath(client: MastermindMcpClient): string {
    if (client === 'pi') return join(this.piDir(), 'skills', '20x-mastermind', 'SKILL.md')
    return join(this.home, client === 'codex' ? '.codex' : '.claude', 'skills', '20x-mastermind', 'SKILL.md')
  }
  private skillSourcePath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, '20x-mastermind-skill', 'SKILL.md')
      : join(app.getAppPath(), 'resources', '20x-mastermind-skill', 'SKILL.md')
  }
  private async bundledSkill(): Promise<string> { return this.bundledOverride ?? readFile(this.skillSourcePath(), 'utf8') }
  private async command(client: MastermindMcpClient): Promise<string> {
    const command = client === 'claude' ? 'claude' : client
    await this.run(command, ['--version'], { timeout: 10000 })
    return command
  }
  private async output(command: string, args: string[]): Promise<string | undefined> {
    try { return (await this.run(command, args, { timeout: 30000 })).stdout }
    catch { return undefined }
  }
  private async configured(client: MastermindMcpClient, command?: string): Promise<boolean> {
    if (client === 'pi' || client === 'claude') {
      try {
        const path = client === 'pi' ? join(this.piDir(), 'mcp.json') : join(this.home, '.claude.json')
        const config = JSON.parse(await readFile(path, 'utf8')) as { mcpServers?: Record<string, { url?: string }> }
        return config.mcpServers?.['20x']?.url === MASTERMIND_MCP_URL
      } catch { return false }
    }
    if (!command) return false
    const value = await this.output(command, ['mcp', 'get', '20x', '--json'])
    return !!value && value.includes(MASTERMIND_MCP_URL)
  }
  async clientStatus(client: MastermindMcpClient): Promise<MastermindMcpClientStatus> {
    let command: string | undefined
    try { command = await this.command(client) } catch { /* unavailable */ }
    const path = this.skillPath(client)
    const content = await readFile(path, 'utf8').catch(() => undefined)
    const bundled = await this.bundledSkill()
    const skill = installedSkillState(content, bundled, !!command)
    return {
      client, available: !!command, configured: await this.configured(client, command), skillState: skill.state,
      ...(skill.version ? { installedVersion: skill.version } : {}), skillPath: path
    }
  }
  async statuses(): Promise<Record<MastermindMcpClient, MastermindMcpClientStatus>> {
    const [codex, pi, claude] = await Promise.all(['codex', 'pi', 'claude'].map(client => this.clientStatus(client as MastermindMcpClient)))
    return { codex, pi, claude }
  }
  private async backup(path: string, backups: string[]): Promise<void> {
    if (!await exists(path)) return
    const backup = `${path}.backup-${Date.now()}`
    await copyFile(path, backup); backups.push(backup)
  }
  private async installSkill(client: MastermindMcpClient, changed: string[], backups: string[]): Promise<void> {
    const source = await this.bundledSkill()
    const target = this.skillPath(client)
    const current = await readFile(target, 'utf8').catch(() => undefined)
    if (current === source) return
    await mkdir(dirname(target), { recursive: true })
    if (current !== undefined) await this.backup(target, backups)
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
    await writeFile(temporary, source, { mode: 0o644 }); await rename(temporary, target); changed.push(target)
  }
  private async installPi(command: string, changed: string[], backups: string[]): Promise<void> {
    const listed = await this.output(command, ['list'])
    if (!listed?.includes('pi-mcp-adapter')) await this.run(command, ['install', 'npm:pi-mcp-adapter'], { timeout: 120000 })
    const path = join(this.piDir(), 'mcp.json')
    let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {}
    try { config = JSON.parse(await readFile(path, 'utf8')) as typeof config }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot update ${path}: ${(error as Error).message}`)
    }
    const next = { ...config, mcpServers: { ...(config.mcpServers ?? {}), '20x': { url: MASTERMIND_MCP_URL, lifecycle: 'lazy' } } }
    if (JSON.stringify(config) === JSON.stringify(next)) return
    await mkdir(dirname(path), { recursive: true }); await this.backup(path, backups)
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); changed.push(path)
  }
  private async installCli(client: 'codex' | 'claude', command: string, changed: string[], backups: string[]): Promise<void> {
    if (await this.configured(client, command)) return
    const configPath = join(this.home, client === 'codex' ? '.codex/config.toml' : '.claude.json')
    await this.backup(configPath, backups)
    const existing = client === 'codex'
      ? await this.output(command, ['mcp', 'get', '20x', '--json'])
      : await readFile(configPath, 'utf8').then(value => !!(JSON.parse(value) as { mcpServers?: Record<string, unknown> }).mcpServers?.['20x'], () => false)
    try {
      if (existing) await this.run(command, ['mcp', 'remove', ...(client === 'claude' ? ['--scope', 'user'] : []), '20x'], { timeout: 30000 })
      const args = client === 'codex'
        ? ['mcp', 'add', '20x', '--url', MASTERMIND_MCP_URL]
        : ['mcp', 'add', '--scope', 'user', '--transport', 'http', '20x', MASTERMIND_MCP_URL]
      await this.run(command, args, { timeout: 30000 }); changed.push(configPath)
    } catch (error) {
      const backup = backups.find(path => path.startsWith(`${configPath}.backup-`))
      if (backup) await copyFile(backup, configPath)
      throw error
    }
  }
  async install(client: MastermindMcpClient, status: () => Promise<MastermindMcpInstallResult['status']>): Promise<MastermindMcpInstallResult> {
    const command = await this.command(client).catch(() => { throw new Error(`${client === 'claude' ? 'Claude Code' : client === 'pi' ? 'Pi' : 'Codex'} is not installed or not available on PATH.`) })
    const changedPaths: string[] = [], backupPaths: string[] = []
    if (client === 'pi') await this.installPi(command, changedPaths, backupPaths)
    else await this.installCli(client, command, changedPaths, backupPaths)
    await this.installSkill(client, changedPaths, backupPaths)
    return { status: await status(), changedPaths, backupPaths, restartRequired: changedPaths.length > 0 }
  }
}
