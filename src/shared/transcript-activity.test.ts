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

  it('keeps the latest text of a running turn visible, even with steps after it', () => {
    const items = groupActivity([user('u1'), tool('t1'), text('live', 'Checking the logs first'), tool('t2'), reasoning('r2')])
    expect(shape(items)).toEqual(['u1', '[t1,t2,r2]', 'live'])
  })

  it('does not fold a lone text into a block when the turn did no work', () => {
    expect(shape(groupActivity([user('u1'), text('a', 'First'), text('b', 'Second')]))).toEqual(['u1', 'a', 'b'])
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
    const [, item] = groupActivity([
      user('u'),
      tool('t1', 'Read', 0),
      text('n', '**Checking** files', 1),
      tool('t2', 'Bash', 2),
      text('latest', 'Now running the build', 3)
    ])
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

/*
 * Regression: the final answer was folded into the collapsed block because real
 * adapters write more parts after it. Sequences below are copied (ids, part
 * types, tool names, order) from stored transcripts in the local 20x DB.
 */
describe('final answer stays visible with real adapter shapes', () => {
  function finalIsVisible(items: ReturnType<typeof groupActivity>, finalId: string) {
    const visible = items.filter((item) => item.type === 'message').map((item) => item.key)
    expect(visible).toContain(finalId)
    for (const item of items) {
      if (item.type === 'activity') expect(item.block.messages.map((m) => m.id)).not.toContain(finalId)
    }
  }

  it('Codex: a synthetic tool part lands after the answer at turn end', () => {
    const messages: ActivityMessageLike[] = [
      { id: 'user-message-1795759370531', role: 'user', content: 'use mcp to open, you can', timestamp: at(0), partType: 'text' },
      text('agent-msg_0b35835ee21b89a0016b091d0ca9a087', 'Let me check the available 20x/task tools and open it.', 2),
      tool('tool-exec-d7ae794d', 'task-management.open_task', 6),
      tool('tool-exec-a46fe524', 'task-management.get_ui_state', 12),
      tool('tool-exec-fc246d88', 'task-management.open_task', 16),
      text('agent-msg_0b35835ee21b89a0016b091d1b36f487', 'I tried the task MCP’s **open task** action twice. It reported success.', 17),
      // Codex echoes the turn's userMessage item as a synthetic `tool` part when the turn ends.
      tool('tool-synthetic:01a21b99-7128-71f2-bf87-1de646dd44a3:item::45h', 'tool', 18)
    ]
    const items = groupActivity(messages)
    finalIsVisible(items, 'agent-msg_0b35835ee21b89a0016b091d1b36f487')
    expect(shape(items)).toEqual([
      'user-message-1795759370531',
      '[agent-msg_0b35835ee21b89a0016b091d0ca9a087,tool-exec-d7ae794d,tool-exec-a46fe524,tool-exec-fc246d88,tool-synthetic:01a21b99-7128-71f2-bf87-1de646dd44a3:item::45h]',
      'agent-msg_0b35835ee21b89a0016b091d1b36f487'
    ])
  })

  it('Claude Code: system events and late subagent progress follow the answer', () => {
    const system = (id: string, subtype: string, s: number): ActivityMessageLike =>
      ({ id, role: 'assistant', content: subtype, timestamp: at(s), partType: 'text' })
    const progress = (id: string, content: string, s: number): ActivityMessageLike =>
      ({ id, role: 'assistant', content, timestamp: at(s), partType: 'task_progress' })
    const messages: ActivityMessageLike[] = [
      { id: 'user-message-1795759493694', role: 'user', content: 'does each PR has before/after comparison ?', timestamp: at(0), partType: 'text' },
      system('system-ae82a966-ae9a-4fb5-96a9-ef1dad46d0e5', 'commands_changed', 4),
      text('msg_011ChSvpyV8o9vZmcCMtoW6V-text-0', 'I will verify this from the PR bodies on GitHub.', 19),
      tool('tool-toolu_01JJRZCcHHD9YGUeHexakj9w', 'Agent', 24, 'success'),
      system('system-ce6c762c-f16d-4c44-9bfe-80350648a800', 'informational', 24),
      progress('task-bbw3g3syq', 'Fetch first 10 PR bodies', 34),
      text('msg_011ChSvzyd79oCh3UXVrLYBe-text-0', 'No. I read all 20 PR bodies on GitHub. **15 PRs have a before/after comparison.**', 161),
      system('system-4e72a216-166b-4ff0-b3b3-981aa381f7b3', 'notification', 161),
      progress('task-bgq1ew7z6', 'Save all PR bodies to files', 162),
      tool('tool-toolu_01Q', 'tool', 163, 'success')
    ]
    const items = groupActivity(messages)
    finalIsVisible(items, 'msg_011ChSvzyd79oCh3UXVrLYBe-text-0')
    // System events are not answers and stay where they were, outside the block.
    expect(classifyActivityPart(messages[7])).toBe('outside')
    expect(shape(items)).toEqual([
      'user-message-1795759493694',
      'system-ae82a966-ae9a-4fb5-96a9-ef1dad46d0e5',
      '[msg_011ChSvpyV8o9vZmcCMtoW6V-text-0,tool-toolu_01JJRZCcHHD9YGUeHexakj9w,task-bbw3g3syq,task-bgq1ew7z6,tool-toolu_01Q]',
      'system-ce6c762c-f16d-4c44-9bfe-80350648a800',
      'msg_011ChSvzyd79oCh3UXVrLYBe-text-0',
      'system-4e72a216-166b-4ff0-b3b3-981aa381f7b3'
    ])
  })

  it('OpenCode: reasoning, todo updates and tool calls continue after the last text', () => {
    const r = (id: string, content: string, s: number): ActivityMessageLike =>
      ({ id, role: 'assistant', content, timestamp: at(s), partType: 'reasoning' })
    const messages: ActivityMessageLike[] = [
      { id: 'user-message-1786863138947', role: 'user', content: 'continue', timestamp: at(0), partType: 'text' },
      r('msg_00957b938001:prt_009590f1c0015', 'User report: text is not working', 243),
      tool('msg_0095b693d001:prt_0095cfa58001l', 'read', 345, 'error'),
      text('msg_0095b693d001:prt_0095cf816001x', 'Let me re-read the current code carefully.', 348),
      { ...tool('msg_0095d033a001:prt_0095d0e80001v', 'todowrite', 350), partType: 'todowrite', tool: { name: 'todowrite', status: 'completed', todos: [{}] } },
      tool('msg_0095d19f9001:prt_0095d26b6001d', 'read', 356),
      r('msg_0095d2bd6001:prt_0095d47bf001J', 'Very interesting! CanvasConnections uses the same pattern', 373),
      text('msg_0095d2bd6001:prt_0095d64820019', 'CanvasConnections uses the same 0×0 SVG pattern with interactive children.', 373),
      tool('msg_0095d2bd6001:prt_0095d6808001U', 'read', 373),
      r('msg_0095d8971001:prt_0095d98bc001c', 'The code looks correct. Let me think about this from a different angle', 550),
      { id: 'err-1', role: 'system', content: 'Request timed out', timestamp: at(560), partType: 'error' }
    ]
    const items = groupActivity(messages)
    finalIsVisible(items, 'msg_0095d2bd6001:prt_0095d64820019')
    expect(items.at(-1)?.key).toBe('err-1')
  })
})
