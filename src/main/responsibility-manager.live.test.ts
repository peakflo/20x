import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { AgentManager } from './agent-manager'
import { ResponsibilityManager } from './responsibility-manager'
import { projectConversationId } from '../shared/responsibilities'
import { startTaskApiServer, stopTaskApiServer, setResponsibilityManager, setTaskApiAgentController } from './task-api-server'

/** Opt-in real provider acceptance. Uses temporary files and an isolated SQLite DB. */
describe.skipIf(process.env.RUN_RESPONSIBILITY_LIVE !== '1')('Mastermind native execution', () => {
  it('runs a real Codex worker and independent verifier through the HTTP MCP endpoint', async () => {
    const fixture = mkdtempSync(join(tmpdir(), '20x-responsibility-live-'))
    const root = join(fixture, 'project'); mkdirSync(root)
    writeFileSync(join(root, 'answer.txt'), 'before\n')
    const { db } = createTestDb()
    db.getWorkspaceDir = taskId => { const path = join(fixture, 'sessions', taskId); mkdirSync(path, { recursive: true }); return path }
    const agent = db.createAgent({ name: 'Acceptance worker', config: { coding_agent: 'codex', model: process.env.RESPONSIBILITY_LIVE_MODEL ?? 'gpt-5.6-luna', reasoning_effort: 'medium', permission_mode: 'ask', sandbox_mode: 'workspace-write' } })!
    const agents = new AgentManager(db)
    const manager = new ResponsibilityManager(db, agents)
    agents.setResponsibilityManager(manager)
    setResponsibilityManager(manager)
    setTaskApiAgentController(agents)
    await startTaskApiServer(db)
    try {
      const project = manager.createProject('Native acceptance', root, agent.id)
      const taskId = projectConversationId(project.id)
      const human = manager.recordHumanInput(taskId, 'In this temporary test project only, change answer.txt to exactly after followed by a newline. Verify its content. Do not use any external source, secrets, communication, or other agents.')!
      const scope = manager.scopeForToken(manager.tokenForTask(taskId)!)
      const r = manager.propose(scope, {
        kind: 'goal', title: 'Verify native responsibility execution', objective: human.text,
        scope: `Only ${root}; one local text-file change. Use the responsibilities MCP tools to report the result.`,
        finish: 'answer.txt contains exactly after followed by one newline; independently inspect the actual file.',
        stop: 'Stop before any external action, dependency install, or work outside the fixture.', mode: 'edit', priority: 'high',
        maxSteps: 3, deadline: new Date(Date.now() + 8 * 60000).toISOString(), agentId: agent.id
      }, human.id)
      manager.start(); await manager.reconcile()
      await manager.act(r.id, r.revision, 'approve')
      const deadline = Date.now() + 7 * 60000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500))
        const snap = manager.snapshot(project.id)
        const current = snap.responsibilities[0]
        if (current.state === 'completed') break
        if (current.state === 'blocked') throw new Error(JSON.stringify(snap.notices.map(n => ({ kind: n.kind, body: n.body }))))
        const pending = snap.notices.find(n => n.state === 'pending' && n.kind === 'permission')
        // A live test cannot approve an unspecified operation on the engineer's behalf.
        if (pending) throw new Error(`Native provider needs a human decision: ${pending.body}`)
      }
      const snap = manager.snapshot(project.id)
      expect(snap.responsibilities[0].state).toBe('completed')
      expect(snap.steps.map(s => s.phase)).toEqual(['work', 'verify'])
      expect(snap.steps.every(s => s.state === 'settled' && !!s.settledAt && !!s.report?.work.fingerprint)).toBe(true)
      expect(readFileSync(join(root, 'answer.txt'), 'utf8')).toBe('after\n')
      expect(snap.notices.filter(n => n.kind === 'result')).toHaveLength(1)
      console.log('NATIVE_RESPONSIBILITY_RECEIPT', JSON.stringify({ model: agent.config.model, steps: snap.steps.map(s => ({ taskId: s.taskId, sessionId: s.sessionId, phase: s.phase, settledAt: s.settledAt, report: s.report })), notices: snap.notices.length }))
    } finally {
      await manager.stop()
      await agents.stopAllSessions()
      stopTaskApiServer()
      db.db.close()
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 8 * 60000)
})
