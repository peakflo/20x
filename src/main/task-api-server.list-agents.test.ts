import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeAgent } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { handleRoute } from './task-api-server'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

describe('task API list_agents', () => {
  it('includes the current plan usage of each agent harness', async () => {
    const claude = db.createAgent(makeAgent({ name: 'Claude worker', config: { coding_agent: 'claude-code' } }))!
    const codex = db.createAgent(makeAgent({ name: 'Codex worker', config: { coding_agent: 'codex' } }))!
    const apiKey = db.createAgent(makeAgent({ name: 'Claude API', config: { coding_agent: 'claude-code', auth_method: 'api_key' } }))!
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    db.usage.saveProviderUsageLimits({
      provider: 'claude-code',
      checkedAt: new Date().toISOString(),
      windows: [{ id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 85, resetsAt }]
    })
    db.usage.saveProviderUsageLimits({
      provider: 'codex',
      checkedAt: new Date().toISOString(),
      windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent: 10, resetsAt }]
    })

    const agents = await handleRoute(db, '/list_agents', {}) as Array<{ id: string; usage_limits: { level: string; headroom_percent: number | null } }>
    const byId = new Map(agents.map((agent) => [agent.id, agent.usage_limits]))
    expect(byId.get(claude.id)).toMatchObject({ level: 'high', headroom_percent: 15 })
    expect(byId.get(codex.id)).toMatchObject({ level: 'low', headroom_percent: 90 })
    expect(byId.get(apiKey.id)).toMatchObject({ level: 'not_applicable', headroom_percent: null })
  })

  it('reports unknown usage when no plan limits have been read', async () => {
    db.createAgent(makeAgent({ config: { coding_agent: 'codex' } }))
    const [agent] = await handleRoute(db, '/list_agents', {}) as Array<{ usage_limits: { level: string } }>
    expect(agent.usage_limits.level).toBe('unknown')
  })
})
