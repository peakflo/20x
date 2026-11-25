import { describe, expect, it } from 'vitest'
import {
  blockSteps,
  blockSummary,
  classifyActivityPart,
  formatActivityClock,
  formatActivityDuration,
  groupActivity,
  lastActivityBlockId,
  noteSummary,
  notePlainText,
  stepCountsText,
  stepFamily,
  unrecoveredFailure,
  type ActivityMessageLike
} from './transcript-activity'

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

function at(seconds: number): Date {
  return new Date(T0 + seconds * 1000)
}

function user(id: string, s = 0): ActivityMessageLike {
  return { id, role: 'user', content: `user ${id}`, timestamp: at(s), partType: 'text' }
}

function text(id: string, content: string, s = 0): ActivityMessageLike {
  return { id, role: 'assistant', content, timestamp: at(s), partType: 'text' }
}

function tool(id: string, name = 'Bash', s = 0, status = 'completed', extra: Partial<NonNullable<ActivityMessageLike['tool']>> = {}): ActivityMessageLike {
  return { id, role: 'assistant', content: name, timestamp: at(s), partType: 'tool', tool: { name, status, ...extra } }
}

function reasoning(id: string, s = 0): ActivityMessageLike {
  return { id, role: 'assistant', content: 'Thinking about it', timestamp: at(s), partType: 'reasoning' }
}

function shape(items: ReturnType<typeof groupActivity>): string[] {
  return items.map((item) =>
    item.type === 'activity' ? `[${item.block.messages.map((m) => m.id).join(',')}]` : item.message.id
  )
}

describe('classifyActivityPart', () => {
  it('folds tools, thinking, todos and subagent progress', () => {
    expect(classifyActivityPart(tool('t'))).toBe('activity')
    expect(classifyActivityPart(reasoning('r'))).toBe('activity')
    expect(classifyActivityPart({ ...tool('todo', 'TodoWrite'), partType: 'todowrite', tool: { name: 'TodoWrite', status: 'completed', todos: [{}] } })).toBe('activity')
    expect(classifyActivityPart({ id: 'p', role: 'assistant', content: '', timestamp: at(0), partType: 'task_progress' })).toBe('activity')
  })

  it('keeps questions, plan reviews, errors, retries, notifications and system notices outside', () => {
    expect(classifyActivityPart({ ...tool('q', 'AskUserQuestion'), partType: 'question', tool: { name: 'AskUserQuestion', status: 'pending', questions: [{}] } })).toBe('outside')
    // Mobile may receive a question as a plain `tool` part.
    expect(classifyActivityPart({ ...tool('q2', 'question'), tool: { name: 'question', status: 'pending', questions: [{}] } })).toBe('outside')
    expect(classifyActivityPart({ ...text('pr', 'Plan'), partType: 'planreview' })).toBe('outside')
    expect(classifyActivityPart({ ...text('e', 'boom'), partType: 'error' })).toBe('outside')
    expect(classifyActivityPart({ ...text('rt', 'retrying'), partType: 'retry' })).toBe('outside')
    expect(classifyActivityPart({ ...text('n', 'done'), partType: 'task-notification' })).toBe('outside')
    expect(classifyActivityPart({ id: 's', role: 'system', content: 'notice', timestamp: at(0) })).toBe('outside')
    expect(classifyActivityPart({ ...text('st', ''), partType: 'step-start' })).toBe('outside')
    expect(classifyActivityPart(user('u'))).toBe('outside')
  })

  it('returns text for assistant prose and ignores nameless tool parts', () => {
    expect(classifyActivityPart(text('a', 'hello'))).toBe('text')
    expect(classifyActivityPart({ id: 'x', role: 'assistant', content: 'hi', timestamp: at(0) })).toBe('text')
    expect(classifyActivityPart({ id: 'g', role: 'assistant', content: 'x', timestamp: at(0), partType: 'tool' })).toBe('outside')
  })
})

describe('groupActivity', () => {
  it('folds one turn into a single block and keeps the final answer outside', () => {
    const items = groupActivity([
      user('u1'),
      reasoning('r1', 1),
      tool('t1', 'Read', 2),
      text('note', 'Now running the tests', 3),
      tool('t2', 'Bash', 4),
      text('answer', 'All done', 5)
    ])
    expect(shape(items)).toEqual(['u1', '[r1,t1,note,t2]', 'answer'])
    const block = items[1].type === 'activity' ? items[1].block : null
    expect(block?.noteIds.has('note')).toBe(true)
    expect(block?.id).toBe('activity:u1')
  })

  it('starts a new block for every user turn', () => {
    const items = groupActivity([
      user('u1'),
      tool('t1'),
      text('a1', 'first'),
      user('u2'),
      tool('t2'),
      text('a2', 'second')
    ])
    expect(shape(items)).toEqual(['u1', '[t1]', 'a1', 'u2', '[t2]', 'a2'])
  })

  it('keeps cards a person must act on visible, folding later steps into the turn block', () => {
    const items = groupActivity([
      user('u1'),
      tool('t1'),
      { ...tool('q', 'AskUserQuestion'), partType: 'question', tool: { name: 'AskUserQuestion', status: 'pending', questions: [{}] } },
      { ...text('err', 'boom'), partType: 'error' },
      tool('t2')
    ])
    expect(shape(items)).toEqual(['u1', '[t1,t2]', 'q', 'err'])
  })

  it('never hides streaming text that has nothing after it', () => {
    const items = groupActivity([user('u1'), tool('t1'), text('live', 'Partial answ')])
    expect(shape(items)).toEqual(['u1', '[t1]', 'live'])
  })

  it('keeps the block key stable as the turn streams', () => {
    const base = [user('u1'), tool('t1')]
    const first = groupActivity(base)
    const second = groupActivity([...base, tool('t2'), tool('t3')])
    expect(first[1].key).toBe(second[1].key)
  })

  it('groups activity before the first user message', () => {
    expect(shape(groupActivity([tool('t0'), text('a', 'hi')]))).toEqual(['[t0]', 'a'])
  })

  it('accepts a custom classifier', () => {
    const items = groupActivity([user('u1'), tool('t1'), tool('t2')], (m) => (m.id === 't2' ? 'outside' : 'activity'))
    expect(shape(items)).toEqual(['u1', '[t1]', 't2'])
  })

  it('reports the last block as the live one', () => {
    const items = groupActivity([user('u1'), tool('t1'), user('u2'), tool('t2'), text('a', 'x')])
    expect(lastActivityBlockId(items)).toBe('activity:u2')
    expect(lastActivityBlockId(groupActivity([user('u1')]))).toBeNull()
  })
})

describe('block status', () => {
  it('counts only tool steps', () => {
    const [, item] = groupActivity([user('u'), reasoning('r'), tool('t1'), text('n', 'note'), tool('t2')])
    if (item.type !== 'activity') throw new Error('expected block')
    expect(blockSteps(item.block).map((m) => m.id)).toEqual(['t1', 't2'])
  })

  it('reports a failure only until a later call succeeds', () => {
    const failed = groupActivity([user('u'), tool('t1', 'Bash', 0, 'error', { error: 'Error: exit 1\nmore' })])[1]
    if (failed.type !== 'activity') throw new Error('expected block')
    expect(unrecoveredFailure(failed.block)?.id).toBe('t1')

    const recovered = groupActivity([user('u'), tool('t1', 'Bash', 0, 'error'), tool('t2', 'Bash', 1)])[1]
    if (recovered.type !== 'activity') throw new Error('expected block')
    expect(unrecoveredFailure(recovered.block)).toBeNull()

    const stillRunning = groupActivity([user('u'), tool('t1', 'Bash', 0, 'failed'), tool('t2', 'Bash', 1, 'running')])[1]
    if (stillRunning.type !== 'activity') throw new Error('expected block')
    expect(unrecoveredFailure(stillRunning.block)?.id).toBe('t1')
  })
})

describe('summary text', () => {
  it('classifies tool families, including MCP tools', () => {
    expect(stepFamily(tool('a', 'Read'))).toBe('read')
    expect(stepFamily(tool('b', 'MultiEdit'))).toBe('edit')
    expect(stepFamily(tool('c', 'bash'))).toBe('command')
    expect(stepFamily(tool('d', 'Grep'))).toBe('search')
    expect(stepFamily(tool('e', 'WebFetch'))).toBe('web')
    expect(stepFamily(tool('f', 'mcp__task-management__browser_click'))).toBe('browser')
    expect(stepFamily(tool('g', 'mcp__gh__create_pr'))).toBe('tool')
  })

  it('names the largest families', () => {
    expect(stepCountsText([])).toBe('')
    expect(stepCountsText([tool('a', 'Read'), tool('b', 'Read')])).toBe('2 file reads')
    expect(stepCountsText([tool('a', 'custom')])).toBe('1 step')
    expect(stepCountsText([tool('a', 'Read'), tool('b', 'Bash'), tool('c', 'Bash'), tool('d', 'custom')])).toBe(
      '4 steps · 2 commands · 1 file read'
    )
  })

  it('formats durations and clocks', () => {
    expect(formatActivityDuration(42_000)).toBe('42s')
    expect(formatActivityDuration(72_000)).toBe('1m 12s')
    expect(formatActivityDuration(120_000)).toBe('2m')
    expect(formatActivityDuration(3_780_000)).toBe('1h 3m')
    expect(formatActivityClock(42_000)).toBe('0:42')
    expect(formatActivityClock(3_725_000)).toBe('1:02:05')
  })

  it('strips markdown from a note summary', () => {
    expect(noteSummary('\n## **Running** the `tests`\nmore')).toBe('Running the tests')
    expect(noteSummary('- item')).toBe('item')
  })

  it('summarises a finished block with its duration and counts', () => {
    const [, item] = groupActivity([user('u'), tool('t1', 'Read', 0), tool('t2', 'Read', 72)])
    if (item.type !== 'activity') throw new Error('expected block')
    expect(blockSummary(item.block, { running: false })).toEqual({
      title: 'Worked for 1m 12s',
      detail: '2 file reads',
      elapsed: null
    })
  })

  it('summarises a running block with its latest note and a clock', () => {
    const [, item] = groupActivity([user('u'), tool('t1', 'Read', 0), text('n', '**Checking** files', 1), tool('t2', 'Bash', 2)])
    if (item.type !== 'activity') throw new Error('expected block')
    expect(blockSummary(item.block, { running: true, nowMs: T0 + 42_000 })).toEqual({
      title: 'Checking files',
      detail: '2 steps so far',
      elapsed: '0:42'
    })
    const [, fresh] = groupActivity([user('u'), tool('t1', 'Read', 0)])
    if (fresh.type !== 'activity') throw new Error('expected block')
    expect(blockSummary(fresh.block, { running: true, nowMs: T0 + 500 }).title).toBe('Working…')
  })
})

describe('notePlainText', () => {
  it('removes markdown markers but keeps lines and snake_case', () => {
    expect(notePlainText('## Plan\nRun the **full** `test_suite` now')).toBe('Plan\nRun the full test_suite now')
  })
})
