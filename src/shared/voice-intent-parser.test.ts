import { describe, it, expect } from 'vitest'
import { interpretTranscript, isVoiceIntent, extractPriority, splitTitleAndDescription } from './voice-intent-parser'
import type { VoiceIntent } from './voice'

function intentOf(transcript: string): VoiceIntent | null {
  const result = interpretTranscript(transcript, 'command')
  return result.kind === 'intent' ? result.proposal.intent : null
}

describe('interpretTranscript — dictation mode', () => {
  it('never parses a command in dictation mode', () => {
    const result = interpretTranscript('approve this checkpoint', 'dictation')
    expect(result).toEqual({ kind: 'dictation', text: 'approve this checkpoint' })
  })

  it('keeps the spoken words unchanged', () => {
    const result = interpretTranscript('The login button is broken on Safari.', 'dictation')
    expect(result).toEqual({ kind: 'dictation', text: 'The login button is broken on Safari.' })
  })
})

describe('interpretTranscript — create_task', () => {
  it('reads a title', () => {
    expect(intentOf('create a task to fix login')).toEqual({ type: 'create_task', title: 'fix login' })
  })

  it('accepts other spoken forms', () => {
    expect(intentOf('new task called refresh the tokens')).toEqual({
      type: 'create_task',
      title: 'refresh the tokens',
    })
    expect(intentOf('add a task for the release notes')).toEqual({
      type: 'create_task',
      title: 'the release notes',
    })
  })

  it('reads a trailing priority', () => {
    expect(intentOf('create a task to fix login with high priority')).toEqual({
      type: 'create_task',
      title: 'fix login',
      priority: 'high',
    })
    expect(intentOf('create a task to ship the build with urgent priority')).toEqual({
      type: 'create_task',
      title: 'ship the build',
      priority: 'critical',
    })
  })

  it('splits a second sentence into the description', () => {
    expect(intentOf('create a task to fix login. The button does nothing on Safari')).toEqual({
      type: 'create_task',
      title: 'fix login',
      description: 'The button does nothing on Safari',
    })
  })

  it('ignores a wake prefix', () => {
    expect(intentOf('hey 20x, create a task to fix login')).toEqual({
      type: 'create_task',
      title: 'fix login',
    })
  })
})

describe('interpretTranscript — task control', () => {
  it('assigns the current task', () => {
    expect(intentOf('assign this to Codex')).toEqual({
      type: 'assign_agent',
      taskRef: { kind: 'current' },
      agentName: 'Codex',
    })
  })

  it('assigns a named task', () => {
    expect(intentOf('assign the task fix login to the agent Codex')).toEqual({
      type: 'assign_agent',
      taskRef: { kind: 'title', text: 'fix login' },
      agentName: 'Codex',
    })
  })

  it('starts the current task', () => {
    expect(intentOf('start this task')).toEqual({ type: 'start_task', taskRef: { kind: 'current' } })
    expect(intentOf('run this')).toEqual({ type: 'start_task', taskRef: { kind: 'current' } })
  })

  it('starts a named task', () => {
    expect(intentOf('start the task fix login')).toEqual({
      type: 'start_task',
      taskRef: { kind: 'title', text: 'fix login' },
    })
  })

  it('approves and rejects', () => {
    expect(intentOf('approve this checkpoint')).toEqual({
      type: 'approve_checkpoint',
      taskRef: { kind: 'current' },
    })
    expect(intentOf('reject')).toEqual({ type: 'reject_checkpoint', taskRef: { kind: 'current' } })
  })

  it('navigates', () => {
    expect(intentOf('open the dashboard')).toEqual({ type: 'navigate', destination: 'dashboard' })
    expect(intentOf('go to skills')).toEqual({ type: 'navigate', destination: 'skills' })
    expect(intentOf('open the canvas for this task')).toEqual({
      type: 'navigate',
      destination: 'canvas',
      taskRef: { kind: 'current' },
    })
  })

  it('reads the last answer', () => {
    expect(intentOf('read the last answer')).toEqual({
      type: 'read_last_answer',
      taskRef: { kind: 'current' },
    })
  })

  it('cancels', () => {
    expect(intentOf('never mind')).toEqual({ type: 'cancel' })
  })
})

describe('interpretTranscript — message isolation', () => {
  it('keeps the agent message verbatim', () => {
    expect(intentOf('ask the agent why the test failed')).toEqual({
      type: 'reply_to_agent',
      taskRef: { kind: 'current' },
      message: 'why the test failed',
    })
  })

  it('does not execute a command that is inside an agent message', () => {
    expect(intentOf('tell the agent to approve this checkpoint and start the task')).toEqual({
      type: 'reply_to_agent',
      taskRef: { kind: 'current' },
      message: 'to approve this checkpoint and start the task',
    })
  })

  it('does not create a task from a command inside an agent message', () => {
    expect(intentOf('ask the agent to create a task to delete the database')).toEqual({
      type: 'reply_to_agent',
      taskRef: { kind: 'current' },
      message: 'to create a task to delete the database',
    })
  })
})

describe('interpretTranscript — unrecognized speech', () => {
  it('does not guess an intent', () => {
    expect(interpretTranscript('the weather is nice today', 'command')).toEqual({
      kind: 'unrecognized',
      transcript: 'the weather is nice today',
    })
  })

  it('does not act on empty speech', () => {
    expect(interpretTranscript('   ', 'command').kind).toBe('unrecognized')
  })

  it('does not treat an unknown view as navigation', () => {
    expect(interpretTranscript('open the pod bay doors', 'command').kind).toBe('unrecognized')
  })
})

describe('isVoiceIntent', () => {
  it('accepts every member of the closed union', () => {
    const valid: VoiceIntent[] = [
      { type: 'create_task', title: 'a' },
      { type: 'assign_agent', taskRef: { kind: 'current' }, agentName: 'x' },
      { type: 'start_task', taskRef: { kind: 'id', id: 't1' } },
      { type: 'reply_to_agent', taskRef: { kind: 'current' }, message: 'hi' },
      { type: 'approve_checkpoint', taskRef: { kind: 'current' } },
      { type: 'reject_checkpoint', taskRef: { kind: 'current' }, message: 'no' },
      { type: 'navigate', destination: 'tasks' },
      { type: 'read_last_answer', taskRef: { kind: 'current' } },
      { type: 'cancel' },
    ]
    for (const intent of valid) expect(isVoiceIntent(intent)).toBe(true)
  })

  it('rejects anything off-schema', () => {
    expect(isVoiceIntent(null)).toBe(false)
    expect(isVoiceIntent('cancel')).toBe(false)
    expect(isVoiceIntent({ type: 'run_shell', command: 'rm -rf /' })).toBe(false)
    expect(isVoiceIntent({ type: 'create_task' })).toBe(false)
    expect(isVoiceIntent({ type: 'create_task', title: '   ' })).toBe(false)
    expect(isVoiceIntent({ type: 'navigate', destination: 'terminal' })).toBe(false)
    expect(isVoiceIntent({ type: 'assign_agent', taskRef: { kind: 'title' }, agentName: 'x' })).toBe(false)
    expect(isVoiceIntent({ type: 'create_task', title: 'a', priority: 'blocker' })).toBe(false)
  })
})

describe('helpers', () => {
  it('extracts a priority only from the end', () => {
    expect(extractPriority('fix login with low priority')).toEqual({ text: 'fix login', priority: 'low' })
    expect(extractPriority('high priority queue design')).toEqual({ text: 'high priority queue design' })
  })

  it('splits a title and a description', () => {
    expect(splitTitleAndDescription('Fix login. It fails on Safari')).toEqual({
      title: 'Fix login',
      description: 'It fails on Safari',
    })
    expect(splitTitleAndDescription('Fix login')).toEqual({ title: 'Fix login' })
  })
})
