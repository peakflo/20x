import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { pack as tarPack } from 'tar-stream'
import { app } from 'electron'
import { DatabaseManager, SCHEMA_VERSION } from './database'
import {
  exportBundle,
  importBundle,
  readBundle,
  redactSecrets,
  sanitizeRows,
  summarizeBundle,
  DATA_CATEGORIES
} from './data-transfer'

describe('redactSecrets', () => {
  it('blanks credential strings and drops credential objects, keeping the rest', () => {
    expect(
      redactSecrets({
        model: 'opus',
        api_keys: { anthropic: 'sk-1' },
        nested: { Authorization: 'Bearer x', 'X-Team': 'core', client_secret: 's' },
        list: [{ api_token: 't', name: 'n' }]
      })
    ).toEqual({
      model: 'opus',
      nested: { Authorization: '', 'X-Team': 'core', client_secret: '' },
      list: [{ api_token: '', name: 'n' }]
    })
  })
})

describe('sanitizeRows', () => {
  it('drops credential and machine-local settings', () => {
    const rows = [
      { key: 'theme', value: 'dark' },
      { key: 'enterprise_jwt', value: 'jwt' },
      { key: 'mobile_auth_token', value: 't' },
      { key: 'anthropic_api_key', value: 'sk' },
      { key: '__schema_version', value: '9' },
      { key: 'OPENCODE_BINARY_PATH', value: 'C:\\oc.exe' }
    ]
    expect(sanitizeRows('settings', rows)).toEqual([{ key: 'theme', value: 'dark' }])
  })

  it('removes secret values, MCP OAuth data and the built-in MCP server', () => {
    const secrets = sanitizeRows('secrets', [{ id: 's', env_var_name: 'A', value: Buffer.from('x') }])
    expect(secrets).toEqual([{ id: 's', env_var_name: 'A' }])

    const servers = sanitizeRows('mcp_servers', [
      { id: '1', name: 'task-management', headers: '{}', environment: '{}' },
      { id: '2', name: 'gh', headers: '{"Authorization":"Bearer x"}', environment: '{"GITHUB_TOKEN":"t","DEBUG":"1"}', oauth_metadata: '{"client_secret":"s"}' }
    ])
    expect(servers).toEqual([
      { id: '2', name: 'gh', headers: '{"Authorization":""}', environment: '{"GITHUB_TOKEN":"","DEBUG":"1"}', oauth_metadata: '{}' }
    ])
  })
})

describe('export and import between two installs', () => {
  let root: string
  let sourceDir: string
  let targetDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '20x-transfer-'))
    sourceDir = join(root, 'source')
    targetDir = join(root, 'target')
    mkdirSync(sourceDir)
    mkdirSync(targetDir)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function open(dir: string): DatabaseManager {
    vi.mocked(app.getPath).mockReturnValue(dir)
    const db = new DatabaseManager()
    db.initialize()
    return db
  }

  async function exportFrom(db: DatabaseManager, dir: string) {
    const outPath = join(root, 'out.20x')
    await exportBundle({
      db: db.db,
      userDataDir: dir,
      outPath,
      categories: [...DATA_CATEGORIES],
      appVersion: '1.0.0',
      schemaVersion: SCHEMA_VERSION
    })
    return outPath
  }

  it('moves tasks, transcripts, attachments and setups, and never moves secrets', async () => {
    const source = open(sourceDir)
    const skill = source.createSkill({ name: 'Reviewer', description: 'd', content: 'c' })!
    const server = source.createMcpServer({ name: 'github', command: 'gh-mcp', environment: { GITHUB_TOKEN: 'ghp_x', DEBUG: '1' } })!
    const secret = source.createSecret({ name: 'DB', description: '', env_var_name: 'DATABASE_URL', value: 'postgres://pw' })!
    const agent = source.createAgent({
      name: 'Backend',
      config: { model: 'opus', skill_ids: [skill.id], secret_ids: [secret.id], mcp_servers: [{ serverId: server.id }], api_keys: { anthropic: 'sk-live' } }
    })!
    const task = source.createTask({ title: 'Fix login' })!
    source.updateTask(task.id, { agent_id: agent.id, skill_ids: [skill.id] })
    const child = source.createTask({ title: 'Write test', parent_task_id: task.id })!
    source.upsertTranscriptParts(task.id, [{ id: 'p1', role: 'assistant', content: 'hello' }])
    source.setSetting('theme', 'dark')
    source.setSetting('enterprise_jwt', 'secret-jwt')
    mkdirSync(join(sourceDir, 'attachments', task.id), { recursive: true })
    writeFileSync(join(sourceDir, 'attachments', task.id, 'a1-notes.txt'), 'notes')

    const bundlePath = await exportFrom(source, sourceDir)
    source.close()

    const bundle = await readBundle(bundlePath)
    const everything = JSON.stringify([...bundle.tables.values()])
    expect(everything).not.toContain('postgres://pw')
    expect(everything).not.toContain('sk-live')
    expect(everything).not.toContain('ghp_x')
    expect(everything).not.toContain('secret-jwt')
    expect(summarizeBundle(bundle).tasks).toBe(2)

    const target = open(targetDir)
    const result = await importBundle({
      db: target.db,
      userDataDir: targetDir,
      bundle,
      categories: [...DATA_CATEGORIES],
      encryptEmptySecret: () => Buffer.from('')
    })

    expect(result.tables.tasks.inserted).toBe(2)
    expect(result.attachments).toBe(1)
    expect(result.secretsNeedingValues).toEqual(['DATABASE_URL'])

    const imported = target.getTask(task.id)!
    expect(imported.agent_id).toBe(agent.id)
    expect(target.getTask(child.id)!.parent_task_id).toBe(task.id)
    expect(target.getTranscriptParts(task.id).map((p) => p.content)).toEqual(['hello'])
    expect(readFileSync(join(targetDir, 'attachments', task.id, 'a1-notes.txt'), 'utf8')).toBe('notes')
    expect(target.getSetting('theme')).toBe('dark')
    expect(target.getSetting('enterprise_jwt')).toBeUndefined()

    const importedAgent = target.getAgent(agent.id)!
    expect(importedAgent.config.api_keys).toBeUndefined()
    expect(importedAgent.config.model).toBe('opus')

    // An empty secret is never injected into an agent's environment.
    expect(target.getSecretsWithValues([secret.id])).toEqual([])

    // The search index follows imported tasks.
    const hits = target.db.prepare(`SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH 'login'`).all()
    expect(hits).toHaveLength(1)
    target.close()
  })

  it('matches seeded records by name and points references at the existing row', async () => {
    const source = open(sourceDir)
    const sourceSkill = source.getSkillByName('Mastermind')!
    const agent = source.createAgent({ name: 'Helper', config: { skill_ids: [sourceSkill.id] } })!
    const task = source.createTask({ title: 'Plan' })!
    source.updateTask(task.id, { skill_ids: [sourceSkill.id] })
    const bundlePath = await exportFrom(source, sourceDir)
    source.close()

    const target = open(targetDir)
    const targetSkill = target.getSkillByName('Mastermind')!
    expect(targetSkill.id).not.toBe(sourceSkill.id)
    const builtInServers = () => target.db.prepare(`SELECT COUNT(*) AS n FROM mcp_servers WHERE name = 'task-management'`).get() as { n: number }
    const before = builtInServers().n

    await importBundle({
      db: target.db,
      userDataDir: targetDir,
      bundle: await readBundle(bundlePath),
      categories: [...DATA_CATEGORIES],
      encryptEmptySecret: () => Buffer.from('')
    })

    expect(target.getSkills().filter((s) => s.name === 'Mastermind')).toHaveLength(1)
    expect(target.getAgent(agent.id)!.config.skill_ids).toEqual([targetSkill.id])
    expect(target.getTask(task.id)!.skill_ids).toEqual([targetSkill.id])
    expect(builtInServers().n).toBe(before)
    target.close()
  })

  it('keeps existing rows and drops references to data that was not imported', async () => {
    const source = open(sourceDir)
    const agent = source.createAgent({ name: 'Only here' })!
    const task = source.createTask({ title: 'Original' })!
    source.updateTask(task.id, { agent_id: agent.id })
    const bundlePath = await exportFrom(source, sourceDir)
    source.close()

    const target = open(targetDir)
    const bundle = await readBundle(bundlePath)
    await importBundle({ db: target.db, userDataDir: targetDir, bundle, categories: ['tasks'], encryptEmptySecret: () => Buffer.from('') })
    expect(target.getTask(task.id)!.agent_id).toBeNull()

    target.updateTask(task.id, { title: 'Changed here' })
    const again = await importBundle({ db: target.db, userDataDir: targetDir, bundle, categories: ['tasks'], encryptEmptySecret: () => Buffer.from('') })
    expect(again.tables.tasks).toMatchObject({ inserted: 0, skipped: 1 })
    expect(target.getTask(task.id)!.title).toBe('Changed here')
    target.close()
  })
})

describe('readBundle', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '20x-bundle-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function writeTar(entries: Array<[string, string]>): Promise<string> {
    const path = join(dir, 'b.20x')
    const pack = tarPack()
    const done = pipeline(pack, createGzip(), createWriteStream(path))
    for (const [name, body] of entries) pack.entry({ name }, body)
    pack.finalize()
    await done
    return path
  }

  const manifest = JSON.stringify({ format: '20x-export', version: 1, appVersion: '1', schemaVersion: 9, exportedAt: '', categories: ['tasks'], counts: {} })

  it('ignores entries that would write outside the attachments folder', async () => {
    const path = await writeTar([
      ['manifest.json', manifest],
      ['attachments/../../evil.txt', 'x'],
      ['attachments/task1/../../evil.txt', 'x'],
      ['attachments/task1/ok.txt', 'ok']
    ])
    const bundle = await readBundle(path)
    expect([...bundle.attachments.keys()]).toEqual(['task1/ok.txt'])
  })

  it('rejects files that are not exports or come from a newer version', async () => {
    const notTar = join(dir, 'x.20x')
    writeFileSync(notTar, 'hello')
    await expect(readBundle(notTar)).rejects.toThrow(/not a 20x export/)

    const newer = await writeTar([['manifest.json', manifest.replace('"version":1', '"version":99')]])
    await expect(readBundle(newer)).rejects.toThrow(/newer version/)
  })
})
