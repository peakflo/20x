import { describe, expect, it } from 'vitest'
import { TaskStatus } from '@/types'
import { resolveRunShortcut, RunShortcutAction, type RunShortcutInput } from './run-shortcut'

const base: RunShortcutInput = {
  taskStatus: TaskStatus.NotStarted,
  assignedAgent: null,
  agentConfigured: true,
  persistedSessionId: null,
  liveSessionId: null,
  liveSessionIdle: true,
  liveSessionErrored: false,
  liveSessionPendingSend: false,
  liveMessageCount: 0
}

describe('resolveRunShortcut', () => {
  describe('unassigned task', () => {
    it('triages and starts in one press when a triage agent is configured', () => {
      expect(resolveRunShortcut(base)).toEqual({ action: RunShortcutAction.TRIAGE })
    })

    it('does nothing and says why when no agent is configured', () => {
      expect(resolveRunShortcut({ ...base, agentConfigured: false })).toEqual({
        action: null,
        blockedReason: 'No agent is configured for triage'
      })
    })

    it('does not triage a second time while triage is in progress', () => {
      expect(resolveRunShortcut({ ...base, taskStatus: TaskStatus.Triaging })).toEqual({
        action: null,
        blockedReason: 'Triage is already in progress'
      })
    })

    it('does not triage while a session is already live for the task', () => {
      expect(resolveRunShortcut({ ...base, liveSessionId: 'triage-session' })).toMatchObject({ action: null })
      expect(resolveRunShortcut({ ...base, liveSessionIdle: false })).toMatchObject({ action: null })
    })
  })

  describe('assigned task', () => {
    const assigned: RunShortcutInput = { ...base, assignedAgent: 'agent-1' }

    it('starts a session when there is none yet', () => {
      expect(resolveRunShortcut(assigned)).toEqual({ action: RunShortcutAction.START })
    })

    it('never triages an assigned task', () => {
      expect(resolveRunShortcut(assigned).action).not.toBe(RunShortcutAction.TRIAGE)
    })

    it('resumes a persisted session whose transcript is not loaded yet', () => {
      expect(resolveRunShortcut({ ...assigned, persistedSessionId: 'sess-1' })).toEqual({
        action: RunShortcutAction.RESUME
      })
    })

    it('restarts when the persisted session has a loaded transcript', () => {
      expect(resolveRunShortcut({ ...assigned, persistedSessionId: 'sess-1', liveMessageCount: 4 })).toEqual({
        action: RunShortcutAction.RESTART
      })
    })

    it('does nothing and says why when the assigned agent is not configured', () => {
      expect(resolveRunShortcut({ ...assigned, agentConfigured: false })).toEqual({
        action: null,
        blockedReason: 'The assigned agent is not configured'
      })
    })

    it('does not start a second session while one is running', () => {
      expect(resolveRunShortcut({ ...assigned, liveSessionId: 'sess-1' })).toMatchObject({ action: null })
      expect(resolveRunShortcut({ ...assigned, liveSessionIdle: false })).toMatchObject({ action: null })
    })

    it('continues a failed live session in the same conversation', () => {
      expect(resolveRunShortcut({
        ...assigned,
        taskStatus: TaskStatus.AgentWorking,
        persistedSessionId: 'sess-1',
        liveSessionId: 'sess-1',
        liveSessionIdle: false,
        liveSessionErrored: true
      })).toEqual({ action: RunShortcutAction.CONTINUE })
    })

    it('blocks a second follow-up while the first is pending', () => {
      expect(resolveRunShortcut({
        ...assigned,
        liveSessionId: 'sess-1',
        liveSessionIdle: false,
        liveSessionErrored: true,
        liveSessionPendingSend: true
      })).toMatchObject({ action: null })
    })
  })

  it('never runs a completed task', () => {
    expect(resolveRunShortcut({ ...base, assignedAgent: 'agent-1', taskStatus: TaskStatus.Completed })).toEqual({
      action: null,
      blockedReason: 'This task is already completed'
    })
    expect(resolveRunShortcut({ ...base, taskStatus: TaskStatus.Completed })).toMatchObject({ action: null })
  })

  it.each([TaskStatus.Cancelled, TaskStatus.Expired])('never runs a %s task', (status) => {
    expect(resolveRunShortcut({ ...base, assignedAgent: 'agent-1', taskStatus: status })).toEqual({
      action: null,
      blockedReason: 'This task is closed'
    })
  })
})
