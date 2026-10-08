import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/stores/agent-store'
import {
  PEAKO_SESSION_ID,
  PEAKO_SLEEP_AFTER_MS,
  agentModelLabel,
  countSessions,
  derivePeakoMood,
  findOpenQuestion,
  toPeakoMessages,
  toPeakoTasks,
  type PeakoMoodInput
} from './peako-state'

const calm: PeakoMoodInput = {
  listening: false,
  speaking: false,
  thinking: false,
  waiting: 0,
  working: 0,
  failed: 0,
  celebrating: false,
  idleForMs: 0
}

function message(partial: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role'>): AgentMessage {
  return { content: '', timestamp: new Date(0), ...partial }
}

describe('derivePeakoMood', () => {
  it('is idle when nothing is happening', () => {
    expect(derivePeakoMood(calm)).toBe('idle')
  })

  it('puts listening first, then anything waiting for the user', () => {
    expect(derivePeakoMood({ ...calm, listening: true, waiting: 2 })).toBe('listening')
    expect(derivePeakoMood({ ...calm, waiting: 1, speaking: true, working: 3 })).toBe('needs')
  })

  it('orders the rest: speaking, thinking, party, stuck, working', () => {
    expect(derivePeakoMood({ ...calm, speaking: true, thinking: true })).toBe('speaking')
    expect(derivePeakoMood({ ...calm, thinking: true, celebrating: true })).toBe('thinking')
    expect(derivePeakoMood({ ...calm, celebrating: true, failed: 1 })).toBe('party')
    expect(derivePeakoMood({ ...calm, failed: 1, working: 2 })).toBe('stuck')
    expect(derivePeakoMood({ ...calm, working: 2 })).toBe('working')
  })

  it('dozes off only after a long quiet spell', () => {
    expect(derivePeakoMood({ ...calm, idleForMs: PEAKO_SLEEP_AFTER_MS - 1 })).toBe('idle')
    expect(derivePeakoMood({ ...calm, idleForMs: PEAKO_SLEEP_AFTER_MS })).toBe('sleep')
    expect(derivePeakoMood({ ...calm, working: 1, idleForMs: PEAKO_SLEEP_AFTER_MS })).toBe('working')
  })
})

describe('countSessions', () => {
  it('counts task sessions and leaves Mastermind out', () => {
    const counts = countSessions([
      { taskId: PEAKO_SESSION_ID, status: 'working', pendingApproval: null },
      { taskId: 't1', status: 'working', pendingApproval: null },
      { taskId: 't2', status: 'working', pendingApproval: { action: 'run' } },
      { taskId: 't3', status: 'waiting_approval', pendingApproval: null },
      { taskId: 't4', status: 'error', pendingApproval: null },
      { taskId: 't5', status: 'idle', pendingApproval: null }
    ])
    expect(counts).toEqual({ working: 1, waiting: 2, failed: 1 })
  })
})

describe('toPeakoMessages', () => {
  it('keeps what was said, folds tool runs into one line, and drops reasoning', () => {
    const out = toPeakoMessages([
      message({ id: '1', role: 'user', content: "What's going on?" }),
      message({ id: '2', role: 'assistant', partType: 'reasoning', content: 'thinking hard' }),
      message({ id: '3', role: 'assistant', partType: 'tool', tool: { name: 'list_tasks', status: 'done' } }),
      message({ id: '4', role: 'assistant', partType: 'tool', tool: { name: 'get_task', status: 'done', title: 'Reading task' } }),
      message({ id: '5', role: 'assistant', partType: 'text', content: '3 agents are working.' }),
      message({ id: '6', role: 'assistant', partType: 'step-finish', content: '' })
    ])
    expect(out).toEqual([
      { id: '1', role: 'user', text: "What's going on?" },
      { id: '3', role: 'tool', text: 'Reading task' },
      { id: '5', role: 'assistant', text: '3 agents are working.' }
    ])
  })

  it('carries a question with its choices', () => {
    const [question] = toPeakoMessages([
      message({
        id: 'q',
        role: 'assistant',
        partType: 'question',
        tool: {
          name: 'question',
          status: 'pending',
          questions: [
            {
              header: 'Which task?',
              question: 'Which task should I start?',
              options: [
                { label: 'Billing fix', description: '' },
                { label: 'Docs update', description: '' }
              ]
            }
          ]
        }
      })
    ])
    expect(question).toEqual({
      id: 'q',
      role: 'question',
      text: 'Which task should I start?',
      options: ['Billing fix', 'Docs update']
    })
  })

  it('drops the choices once a question is answered or cancelled', () => {
    const [question] = toPeakoMessages([
      message({
        id: 'q',
        role: 'assistant',
        partType: 'question',
        tool: {
          name: 'question',
          status: 'completed',
          questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: '' }] }]
        }
      })
    ])
    expect(question.options).toBeUndefined()
  })

  it('keeps only the latest 40 messages', () => {
    const many = Array.from({ length: 60 }, (_, i) => message({ id: String(i), role: 'user', content: `m${i}` }))
    const out = toPeakoMessages(many)
    expect(out).toHaveLength(40)
    expect(out[0].id).toBe('20')
  })
})

describe('agentModelLabel', () => {
  it('reads the model from an agent config', () => {
    expect(agentModelLabel({ model: ' claude-sonnet-5 ' })).toBe('claude-sonnet-5')
    expect(agentModelLabel({ model: '' })).toBeNull()
    expect(agentModelLabel(null)).toBeNull()
  })
})

describe('toPeakoTasks', () => {
  const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Task ${id}`,
    status,
    agent_id: 'a1',
    snoozed_until: null,
    ...extra
  })
  const names = new Map([['a1', 'Backend']])

  it('puts what needs the user first, then running, review, and up next', () => {
    const tasks = [task('next', 'not_started'), task('review', 'ready_for_review'), task('run', 'agent_working'), task('ask', 'agent_working')]
    const sessions = new Map([['ask', { taskId: 'ask', status: 'working', pendingApproval: { sessionId: 's' } }]])
    expect(toPeakoTasks(tasks, sessions, names).map((t) => [t.id, t.group])).toEqual([
      ['ask', 'needs'],
      ['run', 'running'],
      ['review', 'review'],
      ['next', 'next']
    ])
  })

  it('leaves out finished and snoozed work', () => {
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const tasks = [task('done', 'completed'), task('later', 'not_started', { snoozed_until: later })]
    expect(toPeakoTasks(tasks, new Map(), names)).toEqual([])
  })

  it('names the agent, and says nothing when none is assigned', () => {
    const tasks = [task('1', 'not_started'), task('2', 'not_started', { agent_id: null })]
    expect(toPeakoTasks(tasks, new Map(), names).map((t) => t.agentName)).toEqual(['Backend', null])
  })
})

describe('findOpenQuestion', () => {
  const question = (status: string) =>
    message({
      id: 'q',
      role: 'assistant',
      partType: 'question',
      tool: { name: 'question', status, questions: [{ question: 'Which DB?', header: '', options: [] }] }
    } as Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role'>)

  it('finds a question the agent is still waiting on', () => {
    expect(findOpenQuestion([message({ id: '1', role: 'user', content: 'go' }), question('running')])?.id).toBe('q')
  })

  it('ignores a question already answered or closed', () => {
    expect(findOpenQuestion([question('running'), message({ id: '2', role: 'user', content: 'staging' })])).toBeNull()
    expect(findOpenQuestion([question('completed')])).toBeNull()
  })
})
