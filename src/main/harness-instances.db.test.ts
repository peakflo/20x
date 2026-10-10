import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent, makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'

let db: DatabaseManager
let raw: ReturnType<typeof createTestDb>['rawDb']

beforeEach(() => {
  ;({ db, rawDb: raw } = createTestDb())
})

/** An agent config as written before harness instances: it still carries the free-text account_home. */
function legacyConfig(config: Record<string, unknown>): any {
  return config
}

/** Runs the account_home migration on the test database, as on an upgrade. */
function runAccountHomeMigration(): void {
  ;(db as unknown as { migrateAccountHomesToHarnessInstances(): void }).migrateAccountHomesToHarnessInstances()
}

describe('harness instance store', () => {
  it('creates, lists, renames and retrieves instances', () => {
    const work = db.createHarnessInstance({ harness_type: 'codex', label: 'Work', home_path: '/accounts/codex-work' })
    expect(work.id).toMatch(/^hi_/)
    expect(db.getHarnessInstance(work.id)).toEqual(work)

    const renamed = db.updateHarnessInstance(work.id, { label: 'Team' })
    expect(renamed?.label).toBe('Team')
    expect(renamed?.home_path).toBe('/accounts/codex-work')

    db.createHarnessInstance({ harness_type: 'claude-code', label: 'Personal', home_path: '/accounts/claude' })
    expect(db.listHarnessInstances().map((i) => `${i.harness_type}:${i.label}`)).toEqual(['claude-code:Personal', 'codex:Team'])
  })

  it('rejects an unknown harness type at the database level', () => {
    expect(() => raw.prepare(
      `INSERT INTO harness_instances (id, harness_type, label, home_path, created_at) VALUES ('x', 'pi', 'x', '/x', 'now')`
    ).run()).toThrow()
  })

  it('removing an instance also drops its plan-limit snapshot', () => {
    const instance = db.createHarnessInstance({ harness_type: 'codex', label: 'Work', home_path: '/accounts/codex-work' })
    db.usage.saveProviderUsageLimits({ provider: 'codex', instanceId: instance.id, checkedAt: '2026-10-05T00:00:00Z', windows: [] })
    expect(db.usage.getProviderUsageLimits().map((l) => l.instanceId)).toContain(instance.id)

    db.deleteHarnessInstance(instance.id)

    expect(db.usage.getProviderUsageLimits().map((l) => l.instanceId)).not.toContain(instance.id)
  })

  it('removing an instance moves its agents back to the default instance and keeps their sessions', () => {
    const instance = db.createHarnessInstance({ harness_type: 'codex', label: 'Work', home_path: '/accounts/codex-work' })
    const agent = db.createAgent(makeAgent({ name: 'Coder', config: { coding_agent: 'codex', harness_instance_id: instance.id, model: 'gpt' } }))!
    const task = db.createTask(makeTask({ title: 'Ship' }))!
    db.updateTask(task.id, { agent_id: agent.id, session_id: 'thread-1' })

    expect(db.deleteHarnessInstance(instance.id)).toBe(true)

    expect(db.getHarnessInstance(instance.id)).toBeUndefined()
    const after = db.getAgent(agent.id)!
    expect(after.config).toEqual({ coding_agent: 'codex', model: 'gpt', permission_mode: 'allow' })
    expect(db.getTask(task.id)?.session_id).toBe('thread-1')
  })
})

describe('account_home migration', () => {
  it('moves a non-empty account_home into an instance and points the agent at it', () => {
    const agent = db.createAgent(makeAgent({ name: 'Coder', config: legacyConfig({ coding_agent: 'codex', account_home: '/Users/me/.codex-work' }) }))!

    runAccountHomeMigration()

    const migrated = db.getAgent(agent.id)!
    expect(migrated.config).not.toHaveProperty('account_home')
    const instance = db.getHarnessInstance(migrated.config.harness_instance_id!)!
    expect(instance).toMatchObject({ harness_type: 'codex', label: 'codex-work', home_path: '/Users/me/.codex-work' })
  })

  it('labels the instance from the directory name, without leading dots', () => {
    db.createAgent(makeAgent({ config: legacyConfig({ coding_agent: 'claude-code', account_home: '/Users/me/accounts/Personal/' }) }))
    runAccountHomeMigration()
    expect(db.listHarnessInstances()).toEqual([expect.objectContaining({ harness_type: 'claude-code', label: 'Personal' })])
  })

  it('shares one instance between agents that point at the same directory of the same harness', () => {
    const a = db.createAgent(makeAgent({ name: 'A', config: legacyConfig({ coding_agent: 'codex', account_home: '/accounts/work' }) }))!
    const b = db.createAgent(makeAgent({ name: 'B', config: legacyConfig({ coding_agent: 'codex', account_home: '/accounts/work/' }) }))!
    const c = db.createAgent(makeAgent({ name: 'C', config: legacyConfig({ coding_agent: 'claude-code', account_home: '/accounts/work' }) }))!

    runAccountHomeMigration()

    const ids = [a, b, c].map((agent) => db.getAgent(agent.id)!.config.harness_instance_id)
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
    expect(db.listHarnessInstances()).toHaveLength(2)
  })

  it('leaves agents without an account_home, and agents that already have an instance, unchanged', () => {
    const plain = db.createAgent(makeAgent({ name: 'Plain', config: { coding_agent: 'codex' } }))!
    const blank = db.createAgent(makeAgent({ name: 'Blank', config: legacyConfig({ coding_agent: 'codex', account_home: '   ' }) }))!
    const existing = db.createHarnessInstance({ harness_type: 'codex', label: 'Work', home_path: '/accounts/work' })
    const set = db.createAgent(makeAgent({ name: 'Set', config: legacyConfig({ coding_agent: 'codex', harness_instance_id: existing.id, account_home: '/accounts/other' }) }))!

    runAccountHomeMigration()

    expect(db.getAgent(plain.id)!.config).toEqual({ coding_agent: 'codex', permission_mode: 'allow' })
    expect(db.getAgent(blank.id)!.config).toEqual({ coding_agent: 'codex', permission_mode: 'allow' })
    expect(db.getAgent(set.id)!.config.harness_instance_id).toBe(existing.id)
    expect(db.listHarnessInstances()).toEqual([expect.objectContaining({ id: existing.id })])
  })

  it('is a no-op when run again', () => {
    db.createAgent(makeAgent({ config: legacyConfig({ coding_agent: 'codex', account_home: '/accounts/work' }) }))
    runAccountHomeMigration()
    const first = db.listHarnessInstances()
    runAccountHomeMigration()
    expect(db.listHarnessInstances()).toEqual(first)
  })
})
