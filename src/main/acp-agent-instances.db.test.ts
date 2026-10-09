import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'

let db: DatabaseManager
let raw: ReturnType<typeof createTestDb>['rawDb']

beforeEach(() => {
  ;({ db, rawDb: raw } = createTestDb())
})

describe('ACP agent instance store', () => {
  it('creates, lists, updates and retrieves registry-sourced instances', () => {
    const devin = db.createAcpAgentInstance({
      display_name: 'Devin',
      source: 'registry',
      registry_agent_id: 'devin',
      version: '1.2.3',
      distribution: 'npx',
      command_args: ['--acp'],
      env: { DEVIN_LOG_LEVEL: 'info' },
      secret_ids: ['secret_abc'],
      auth_method_id: 'env_var'
    })
    expect(devin.id).toMatch(/^acp_/)
    expect(db.getAcpAgentInstance(devin.id)).toEqual(devin)
    expect(devin.source).toBe('registry')
    expect(devin.registry_agent_id).toBe('devin')
    expect(devin.command_args).toEqual(['--acp'])
    expect(devin.env).toEqual({ DEVIN_LOG_LEVEL: 'info' })
    expect(devin.secret_ids).toEqual(['secret_abc'])

    const renamed = db.updateAcpAgentInstance(devin.id, { display_name: 'Devin (work)' })
    expect(renamed?.display_name).toBe('Devin (work)')
    // Unrelated fields are preserved across a partial update.
    expect(renamed?.registry_agent_id).toBe('devin')

    db.createAcpAgentInstance({ display_name: 'My Local Agent', source: 'local', command_path: '/usr/local/bin/my-agent' })
    expect(db.listAcpAgentInstances().map((i) => i.display_name)).toEqual(['Devin (work)', 'My Local Agent'])
  })

  it('creates a local-command instance with no registry fields', () => {
    const local = db.createAcpAgentInstance({
      display_name: 'Local ACP',
      source: 'local',
      command_path: '/opt/my-agent/bin/agent',
      command_args: ['--flag', 'value']
    })
    expect(local.source).toBe('local')
    expect(local.registry_agent_id).toBeNull()
    expect(local.version).toBeNull()
    expect(local.distribution).toBe('auto')
    expect(local.command_path).toBe('/opt/my-agent/bin/agent')
  })

  it('rejects an unknown source or distribution at the database level', () => {
    expect(() => raw.prepare(
      `INSERT INTO acp_agent_instances (id, display_name, source, distribution, created_at) VALUES ('x', 'x', 'bogus-source', 'auto', 'now')`
    ).run()).toThrow(/CHECK constraint failed/)
    expect(() => raw.prepare(
      `INSERT INTO acp_agent_instances (id, display_name, source, distribution, created_at) VALUES ('x', 'x', 'local', 'bogus-dist', 'now')`
    ).run()).toThrow(/CHECK constraint failed/)
  })

  it('removing an instance also drops its plan-limit snapshot', () => {
    const instance = db.createAcpAgentInstance({ display_name: 'Devin', source: 'registry', registry_agent_id: 'devin' })
    db.usage.saveProviderUsageLimits({ provider: 'acp', instanceId: instance.id, checkedAt: '2026-10-05T00:00:00Z', windows: [] })
    expect(db.usage.getProviderUsageLimits().map((l) => l.instanceId)).toContain(instance.id)

    db.deleteAcpAgentInstance(instance.id)

    expect(db.usage.getProviderUsageLimits().map((l) => l.instanceId)).not.toContain(instance.id)
  })

  it('removing an instance clears acp_instance_id on agents that referenced it, leaving coding_agent untouched', () => {
    const instance = db.createAcpAgentInstance({ display_name: 'Devin', source: 'registry', registry_agent_id: 'devin' })
    const agent = db.createAgent(makeAgent({ name: 'My ACP Agent', config: { coding_agent: 'acp', acp_instance_id: instance.id } }))!

    expect(db.agentsReferencingAcpInstance(instance.id).map((a) => a.id)).toEqual([agent.id])
    expect(db.deleteAcpAgentInstance(instance.id)).toBe(true)

    const updated = db.getAgent(agent.id)
    expect(updated?.config.coding_agent).toBe('acp')
    expect(updated?.config.acp_instance_id).toBeUndefined()
    expect(db.getAcpAgentInstance(instance.id)).toBeUndefined()
  })

  it('deleting a non-existent instance returns false', () => {
    expect(db.deleteAcpAgentInstance('acp_does_not_exist')).toBe(false)
  })
})
