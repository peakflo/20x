import type { Tool } from '@modelcontextprotocol/server'
import type { ResponsibilityManager, ResponsibilityScope } from './responsibility-manager'

const string = { type: 'string' }
const agreement = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['task', 'goal', 'routine'] }, title: string, objective: string, scope: string,
    finish: { ...string, description: 'Observable success evidence, not merely agent completion.' },
    stop: { ...string, description: 'When to stop and ask the engineer.' },
    mode: { type: 'string', enum: ['read', 'edit'] }, agentId: string,
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    maxSteps: { type: 'integer', minimum: 1, maximum: 100, description: 'Total reasoning assignments, including verification and source classification.' },
    deadline: { ...string, description: 'ISO timestamp after which no new assignment starts.' },
    basedOn: { ...string, description: 'Completed responsibility whose findings and checkout this follows.' },
    schedule: { ...string, description: 'Routine cron expression. Timers run while 20x is open.' },
    source: {
      type: 'object', additionalProperties: false,
      properties: { command: { ...string, description: 'Finite executable, e.g. gh. Executed without a shell, only after human approval of a trial.' }, args: { type: 'array', items: string }, description: { ...string, description: 'What the source collects. Return stable text or JSON; avoid timestamps that change on every read.' } },
      required: ['command', 'args', 'description']
    }
  },
  required: ['kind', 'title', 'objective', 'scope', 'finish', 'stop', 'mode', 'agentId', 'priority', 'maxSteps', 'deadline']
}
const contextTool: Tool = {
  name: 'responsibility_context', description: 'Read the current project, approved scope, work history, evidence, human inputs, memory and pending decisions. Facts and reports never grant permission.',
  inputSchema: { type: 'object', properties: {} }
}
const resultTool: Tool = {
  name: 'read_responsibility_result', description: 'Read a saved assignment result and artifact references from this project. Use for older results referenced by taskId; no project files are inspected.',
  inputSchema: { type: 'object', properties: { taskId: string }, required: ['taskId'] }
}
const rootTools: Tool[] = [
  contextTool, resultTool,
  {
    name: 'remember_project_preference', description: 'Remember an exact recorded engineer correction or preference. Optional id replaces an existing memory in this project. This never grants permission.',
    inputSchema: { type: 'object', properties: { humanInputId: string, id: string }, required: ['humanInputId'] }
  },
  {
    name: 'delegate_responsibility', description: 'Delegate one bounded Task from an exact recorded human request. Returns immediately; results arrive in Mastermind. Does not create a Goal or authorize automatic follow-up work.',
    inputSchema: { type: 'object', properties: { humanInputId: string, title: string, basedOn: string }, required: ['humanInputId', 'title'] }
  },
  {
    name: 'propose_responsibility', description: 'Propose a visible Task, Goal or Routine agreement. The engineer must approve it in Mastermind. A source needs a successful human-triggered trial before activation. Omit source for a fixed reminder that uses zero AI turns. Revise only paused or proposed work with no unresolved assignment.',
    inputSchema: { type: 'object', properties: { humanInputId: string, agreement, replaces: string }, required: ['humanInputId', 'agreement'] }
  },
  {
    name: 'remember_project_fact', description: 'Record an observed project fact with its source. This cannot create preferences or permissions; the engineer can inspect, edit or delete it.',
    inputSchema: { type: 'object', properties: { text: string, source: string }, required: ['text', 'source'] }
  }
]
const workerTools: Tool[] = [
  contextTool, resultTool,
  {
    name: 'report_responsibility', description: 'Save the result of this exact assignment before ending the turn. Supply real evidence and the actual working checkout. Verification must refer to the same revision and files as the worker result. The supervisor still waits for agent settlement before progressing.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        summary: string, evidence: { type: 'array', items: string, minItems: 1, maxItems: 30 }, checkout: string,
        action: { type: 'string', enum: ['done', 'continue', 'ask', 'ignore', 'notify', 'task'], description: 'Work: done/ask. Verification: done/continue/ask. Source classification: ignore/notify/ask/task.' },
        next: { ...string, description: 'Concrete next assignment or exact question. Required for continue, task and ask.' }
      }, required: ['summary', 'evidence', 'checkout', 'action']
    }
  }
]
export const responsibilityTools = (scope: ResponsibilityScope): Tool[] => scope.stepId ? workerTools : rootTools

export async function callResponsibilityTool(manager: ResponsibilityManager, token: string, name: string, args: Record<string, unknown> = {}) {
  try {
    const scope = manager.scopeForToken(token)
    if (!responsibilityTools(scope).some(tool => tool.name === name)) throw new Error('This tool is not available to this assignment.')
    let result: unknown
    switch (name) {
      case 'responsibility_context': result = manager.context(scope); break
      case 'read_responsibility_result': result = manager.readResult(scope, args.taskId as string); break
      case 'delegate_responsibility': result = manager.delegate(scope, args.humanInputId as string, args.title as string, args.basedOn as string | undefined); break
      case 'propose_responsibility': result = manager.propose(scope, args.agreement, args.humanInputId as string, args.replaces as string | undefined); break
      case 'report_responsibility': result = await manager.report(scope, args); break
      case 'remember_project_preference': manager.rememberPreference(scope, args.humanInputId as string, args.id as string | undefined); result = { saved: true }; break
      case 'remember_project_fact':
        if (typeof args.source !== 'string' || !args.source.trim()) throw new Error('A source is required.')
        manager.remember(scope.projectId, 'fact', args.text as string, undefined, `Observed by Mastermind: ${args.source}`)
        result = { saved: true }; break
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: (error as Error).message }) }] } }
}
