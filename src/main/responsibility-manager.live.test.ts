import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { AgentManager } from './agent-manager'
import { ResponsibilityManager, collectSource } from './responsibility-manager'
import { projectConversationId } from '../shared/responsibilities'
import { RoutineSources } from './routine-sources'
import { startTaskApiServer, stopTaskApiServer, setResponsibilityManager, setTaskApiAgentController } from './task-api-server'

/** Opt-in real provider acceptance. Uses temporary files and an isolated SQLite DB. */
describe.skipIf(process.env.RUN_RESPONSIBILITY_LIVE !== '1')('Mastermind native execution', () => {
  it('reads Git and the current GitHub PR through the existing command collector', async () => {
    const signal = new AbortController().signal
    const revision = await collectSource({ command: 'git', args: ['rev-parse', 'HEAD'], description: 'Current checkout revision' }, process.cwd(), signal)
    const pull = JSON.parse(await collectSource({ command: 'gh', args: ['pr', 'view', '526', '--repo', 'peakflo/20x', '--json', 'number,state,headRefOid'], description: 'Current responsibility PR' }, process.cwd(), signal))
    expect(revision).toMatch(/^[a-f0-9]{40}$/)
    expect(pull.number).toBe(526)
    expect(pull.headRefOid).toMatch(/^[a-f0-9]{40}$/)
    console.log('LIVE_GIT_SOURCE_RECEIPT', JSON.stringify({ revision, pull }))
  })

  it('collects a configured MCP source and runs native classification and bounded collection reasoning', async () => {
    const fixture = mkdtempSync(join(tmpdir(), '20x-source-live-'))
    const root = join(fixture, 'project'); mkdirSync(root)
    const state = join(root, 'source.json'); writeFileSync(state, '{"release":"green"}')
    const script = join(fixture, 'source.cjs')
    writeFileSync(script, `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'release-evidence',version:'1'}};
if(m.method==='tools/list')result={tools:[{name:'read_release',description:'Read the chosen local source fixture.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]};
if(m.method==='tools/call')result={content:[{type:'text',text:fs.readFileSync(${JSON.stringify(state)},'utf8')}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`)
    const { db } = createTestDb()
    db.getWorkspaceDir = taskId => { const path = join(fixture, 'sessions', taskId); mkdirSync(path, { recursive: true }); return path }
    const server = db.createMcpServer({ name: 'Release evidence', type: 'local', command: process.execPath, args: [script], environment: { ELECTRON_RUN_AS_NODE: '1' } })!
    const agent = db.createAgent({ name: 'Source acceptance', config: { coding_agent: 'codex', model: process.env.RESPONSIBILITY_LIVE_MODEL ?? 'gpt-5.6-luna', reasoning_effort: 'medium', mcp_servers: [{ serverId: server.id, enabledTools: ['read_release'] }] } })!
    const agents = new AgentManager(db)
    const sources = new RoutineSources(db, (agentId, serverId) => agents.resolveRoutineMcpConnection(agentId, serverId))
    const manager = new ResponsibilityManager(db, agents, undefined, undefined, undefined, sources)
    agents.setResponsibilityManager(manager); setResponsibilityManager(manager); setTaskApiAgentController(agents)
    await startTaskApiServer(db)
    const until = async (done: () => boolean) => {
      const deadline = Date.now() + 90000
      while (!done() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250)); await manager.reconcile()
        const snap = manager.snapshot()
        const issue = snap.notices.find(n => n.state === 'pending' && n.kind !== 'result')
        if (issue) throw new Error(`Native source journey needs intervention: ${issue.body}`)
      }
      expect(done()).toBe(true)
    }
    try {
      const project = manager.createProject('Source acceptance', root, agent.id)
      const taskId = projectConversationId(project.id)
      const human = manager.recordHumanInput(taskId, 'Monitor this local release evidence fixture only. Notify me if the release becomes red. No file edits, external communication or other sources. Use only the supplied evidence and report through the responsibilities MCP tools.')!
      const scope = manager.scopeForToken(manager.tokenForTask(taskId)!)
      manager.start(); await manager.reconcile()
      await manager.sourceTools(scope, server.id)
      const r = manager.propose(scope, {
        kind: 'routine', title: 'Watch local release evidence', objective: human.text, scope: human.text,
        finish: 'Report a changed release state with its source evidence.', stop: 'Stop when source data is insufficient or permission is needed.', mode: 'read', priority: 'high',
        maxSteps: 4, deadline: new Date(Date.now() + 8 * 60000).toISOString(), agentId: agent.id, schedule: '* * * * *',
        source: { kind: 'collection', description: 'Read the local fixture through its independently configured MCP connection.', reads: [{ kind: 'mcp', serverId: server.id, tool: 'read_release', arguments: {}, description: 'Release status' }] }
      }, human.id)
      await manager.act(r.id, r.revision, 'trial'); await manager.act(r.id, r.revision, 'approve'); await manager.reconcile()
      const due = () => db.db.prepare("UPDATE mastermind_agreements SET data=json_set(data, '$.nextAt', ?) WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), r.id)
      due(); await manager.reconcile(); expect(manager.snapshot().steps).toHaveLength(0)
      writeFileSync(state, '{"release":"red"}'); due(); await manager.reconcile()
      await until(() => manager.snapshot().steps.some(s => s.phase === 'classify' && s.state === 'settled'))
      expect(manager.snapshot().notices.filter(n => n.kind === 'result')).toHaveLength(1)
      due(); await manager.reconcile(); expect(manager.snapshot().steps).toHaveLength(1)
      await manager.act(r.id, r.revision, 'pause')
      const current = manager.snapshot().responsibilities[0]
      const revisionInput = manager.recordHumanInput(taskId, 'Use one bounded source-reasoning assignment to extract only the release field from this same evidence. Return a stable JSON snapshot. Keep all source scope and permissions unchanged.')!
      const revised = manager.propose(scope, { ...current.agreement, source: { ...current.agreement.source, reasoning: 'Extract only the release field. Return sourceSnapshot as JSON containing release, using the supplied source evidence. Do not use shell or project tools.' } }, revisionInput.id, r.id)
      await manager.act(revised.id, revised.revision, 'trial')
      await until(() => !!manager.snapshot().responsibilities[0].trial && manager.snapshot().steps.every(s => s.state === 'settled'))
      const result = manager.snapshot().responsibilities[0]
      expect(JSON.parse(result.trial!.output)).toEqual({ release: 'red' })
      expect(result.trial!.evidence).toContain('red')
      expect(result.state).toBe('proposed')
      console.log('NATIVE_SOURCE_RECEIPT', JSON.stringify({ model: agent.config.model, phases: manager.snapshot().steps.map(s => ({ phase: s.phase, taskId: s.taskId, sessionId: s.sessionId, state: s.state })), trial: result.trial!.output, sourceConnectionUnchanged: db.getMcpServer(server.id)?.name === server.name }))
    } finally {
      await manager.stop(); await agents.stopAllSessions(); stopTaskApiServer(); db.db.close(); rmSync(fixture, { recursive: true, force: true })
    }
  }, 4 * 60000)

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

describe.skipIf(process.env.RUN_RESPONSIBILITY_LIVE !== '1')('Factory native execution', () => {
  it('runs a native Factory branch, human handoff and independent verification', async () => {
    const fixture = mkdtempSync(join(tmpdir(), '20x-factory-live-'))
    const root = join(fixture, 'project'); mkdirSync(root)
    writeFileSync(join(root, 'answer.txt'), 'before\n')
    writeFileSync(join(root, 'AGENTS.md'), 'For this isolated acceptance fixture, include FACTORY_PROJECT_CONTEXT=loaded in your final responsibility report summary. Work only in this folder.\n')
    const { db } = createTestDb()
    db.getWorkspaceDir = taskId => { const path = join(fixture, 'sessions', taskId); mkdirSync(path, { recursive: true }); return path }
    const agent = db.createAgent({ name: 'Factory acceptance', config: { coding_agent: 'codex', model: process.env.RESPONSIBILITY_LIVE_MODEL ?? 'gpt-5.6-luna', reasoning_effort: 'medium', permission_mode: 'ask', sandbox_mode: 'workspace-write' } })!
    const agents = new AgentManager(db)
    const manager = new ResponsibilityManager(db, agents)
    agents.setResponsibilityManager(manager); setResponsibilityManager(manager); setTaskApiAgentController(agents)
    await startTaskApiServer(db)
    try {
      manager.start(); await manager.reconcile()
      const project = manager.createProject('Factory acceptance', root, agent.id)
      const taskId = projectConversationId(project.id)
      const human = manager.recordHumanInput(taskId, 'In this temporary test project only, review answer.txt; if it is not exactly after followed by a newline, have a separate assignment fix it. Then ask me before independent verification. No external sources, secrets, installs or communication.')!
      const scope = manager.scopeForToken(manager.tokenForTask(taskId)!)
      manager.proposeFactory(scope, { humanInputId: human.id, name: 'Review and correct fixture', diagram: 'review -> needs correction? -> fix -> human -> verify', guide: 'First create ONE read-only review assignment to inspect answer.txt and report whether it contains exactly after followed by one newline. If the report says it needs correction, create ONE separate edit assignment to make that exact change. If already correct, skip editing. After the worker reports that the file is correct, ask the engineer exactly: Proceed with independent verification? Do not request more work until answered. After the engineer explicitly says yes, report done to request independent verification. Never ask that same question twice. Never create a separate verification task yourself; 20x performs the independent verification when you report done.' })
      manager.decideFactory(manager.snapshot().factoryProposals![0].id, true)
      const f = manager.snapshot().factories![0]
      const r = manager.propose(scope, { kind: 'goal', title: 'Factory native acceptance', objective: human.text, scope: `Only ${root}; inspect and edit answer.txt. Follow project instructions.`, finish: 'answer.txt contains exactly after followed by one newline, confirmed independently after the engineer answers.', stop: 'Ask before any action beyond the fixture. Stop after independent verification.', mode: 'edit', priority: 'high', agentId: agent.id, factoryId: f.id, maxSteps: 12, deadline: new Date(Date.now() + 12 * 60000).toISOString() }, human.id)
      await manager.act(r.id, r.revision, 'approve')
      let answered = false
      const deadline = Date.now() + 10 * 60000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500)); await manager.reconcile()
        const snap = manager.snapshot()
        const pending = snap.notices.find(n => n.state === 'pending' && n.kind !== 'result')
        if (pending) {
          if (pending.kind !== 'question' || !/Proceed with independent verification\?/i.test(pending.body) || answered) throw new Error(`Native Factory requires unexpected intervention: ${pending.body}`)
          expect(readFileSync(join(root, 'answer.txt'), 'utf8')).toBe('after\n')
          await manager.answer(pending.id, 'Yes, proceed with independent verification of answer.txt only.')
          answered = true
        }
        if (snap.responsibilities[0].state === 'completed') break
      }
      const snap = manager.snapshot()
      console.log('NATIVE_FACTORY_TRACE', JSON.stringify(snap.steps.map(s => ({ phase: s.phase, instruction: s.instruction, report: s.report }))))
      expect(answered).toBe(true)
      expect(snap.responsibilities[0].state).toBe('completed')
      expect(snap.steps.filter(s => s.phase === 'work')).toHaveLength(2)
      expect(snap.steps.filter(s => s.phase === 'work').every(s => s.report?.summary.includes('FACTORY_PROJECT_CONTEXT=loaded'))).toBe(true)
      expect(snap.steps.at(-1)?.phase).toBe('verify')
      expect(snap.steps.every(s => s.state === 'settled')).toBe(true)
      expect(readFileSync(join(root, 'answer.txt'), 'utf8')).toBe('after\n')
      expect(snap.steps.every(s => !agents.findSessionByTaskId(s.taskId))).toBe(true)
      console.log('NATIVE_FACTORY_RECEIPT', JSON.stringify({ model: agent.config.model, answered, phases: snap.steps.map(s => ({ taskId: s.taskId, phase: s.phase, state: s.state, sessionId: s.sessionId, predecessors: s.predecessorTaskIds })), finalState: snap.responsibilities[0].state }))
    } finally {
      await manager.stop(); await agents.stopAllSessions(); stopTaskApiServer(); setResponsibilityManager(undefined); db.db.close(); rmSync(fixture, { recursive: true, force: true })
    }
  }, 12 * 60000)
})
