import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  ChildQuestionStore,
  ChildQuestionService,
  DEFAULT_CHILD_QUESTION_ESCALATION_TIMEOUT_MS,
  type ChildQuestionDeps,
  type ChildQuestionParentPolicy
} from './child-questions'

// Fixed, deterministic clock — tests must not depend on the current date.
let now = Date.UTC(2026, 9, 19, 12, 0, 0)

interface FakeTask {
  id: string
  title: string
  status: string
  parent_task_id: string | null
  agent_id: string | null
}

let tasks: Map<string, FakeTask>
let policies: Map<string, ChildQuestionParentPolicy>
let store: ChildQuestionStore
let enqueueParentWakeup: ReturnType<typeof vi.fn<ChildQuestionDeps['enqueueParentWakeup']>>
let cancelParentWakeup: ReturnType<typeof vi.fn<ChildQuestionDeps['cancelParentWakeup']>>
let answerChildSession: ReturnType<typeof vi.fn<ChildQuestionDeps['answerChildSession']>>
let notifyHuman: ReturnType<typeof vi.fn<ChildQuestionDeps['notifyHuman']>>
let appendTranscriptNote: ReturnType<typeof vi.fn<ChildQuestionDeps['appendTranscriptNote']>>
let notifyRaised: ReturnType<typeof vi.fn<NonNullable<ChildQuestionDeps['notifyRaised']>>>
let service: ChildQuestionService

function task(overrides: Partial<FakeTask> & { id: string }): FakeTask {
  const t: FakeTask = { title: 'Child task', status: 'agent_working', parent_task_id: null, agent_id: null, ...overrides }
  tasks.set(t.id, t)
  return t
}

function isDescendant(ancestorId: string, taskId: string): boolean {
  let current = tasks.get(taskId)
  while (current) {
    if (current.parent_task_id === ancestorId) return true
    current = current.parent_task_id ? tasks.get(current.parent_task_id) : undefined
  }
  return false
}

beforeEach(() => {
  now = Date.UTC(2026, 9, 19, 12, 0, 0)
  tasks = new Map()
  policies = new Map()
  store = new ChildQuestionStore(new Database(':memory:'))
  enqueueParentWakeup = vi.fn(async () => undefined)
  cancelParentWakeup = vi.fn(() => undefined)
  answerChildSession = vi.fn(async () => undefined)
  notifyHuman = vi.fn(() => undefined)
  appendTranscriptNote = vi.fn(() => undefined)
  notifyRaised = vi.fn(() => undefined)

  const deps: ChildQuestionDeps = {
    store,
    getTask: (id) => tasks.get(id),
    getParentPolicy: (parentTaskId) => policies.get(parentTaskId) ?? {},
    isDescendant,
    enqueueParentWakeup,
    cancelParentWakeup,
    answerChildSession,
    notifyHuman,
    appendTranscriptNote,
    notifyRaised,
    now: () => now
  }
  service = new ChildQuestionService(deps)
})

describe('ChildQuestionService.raise', () => {
  it('routes to the parent when reachable, allowed, and within authority', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })

    const record = await service.raise({
      childTaskId: 'child-1',
      questionId: 'q1',
      kind: 'approval',
      questionText: 'Run `npm test`?',
      toolName: 'exec',
      command: 'npm test'
    })

    expect(record?.state).toBe('pending_parent')
    expect(record?.escalateAt).toBe(now + DEFAULT_CHILD_QUESTION_ESCALATION_TIMEOUT_MS)
    expect(enqueueParentWakeup).toHaveBeenCalledTimes(1)
    expect(enqueueParentWakeup.mock.calls[0][0]).toMatchObject({ parentTaskId: 'parent-1', childTaskId: 'child-1' })
    expect(notifyHuman).not.toHaveBeenCalled()
    expect(notifyRaised).toHaveBeenCalledWith('child-1', expect.objectContaining({ state: 'pending_parent' }))
  })

  it('is idempotent: raising the same question twice does not duplicate or re-notify', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })

    const first = await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'question', questionText: 'Which env?' })
    const second = await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'question', questionText: 'Which env?' })

    expect(second?.id).toBe(first?.id)
    expect(enqueueParentWakeup).toHaveBeenCalledTimes(1)
  })

  it('escalates straight to the human when there is no parent', async () => {
    task({ id: 'child-1', parent_task_id: null })

    const record = await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'question', questionText: 'Proceed?' })

    expect(record?.state).toBe('escalated')
    expect(notifyHuman).toHaveBeenCalledTimes(1)
    expect(enqueueParentWakeup).not.toHaveBeenCalled()
    expect(notifyRaised).toHaveBeenCalledWith('child-1', expect.objectContaining({ state: 'escalated' }))
  })

  it('escalates when the parent has completed', async () => {
    task({ id: 'parent-1', status: 'completed' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })

    const record = await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'question', questionText: 'Proceed?' })

    expect(record?.state).toBe('escalated')
    expect(enqueueParentWakeup).not.toHaveBeenCalled()
  })

  it('escalates when the "route to parent" setting is off, but still tells the parent for information', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    policies.set('parent-1', { routeToParent: false })

    const record = await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'question', questionText: 'Proceed?' })

    expect(record?.state).toBe('escalated')
    expect(notifyHuman).toHaveBeenCalledTimes(1)
    expect(enqueueParentWakeup).toHaveBeenCalledTimes(1)
    expect(enqueueParentWakeup.mock.calls[0][0].payload).toMatchObject({ informational: true })
  })

  it('escalates when the parent is under its own "ask" permission mode', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    policies.set('parent-1', { permissionMode: 'ask' })

    const record = await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Delete the cache dir?' })

    expect(record?.state).toBe('escalated')
  })

  it('escalates immediately — no escalation timeout — when the parent session cannot reach the answering tools at all (nested scoped)', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    policies.set('parent-1', { canAnswer: false })

    const record = await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run the build?' })

    expect(record?.state).toBe('escalated')
    expect(record?.escalateAt).toBeNull()
    expect(notifyHuman).toHaveBeenCalledTimes(1)
  })

  it('escalates approvals outside the parent\'s authority (e.g. a production deploy) straight to the human', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })

    const record = await service.raise({
      childTaskId: 'child-1',
      questionId: 'q1',
      kind: 'approval',
      questionText: 'Deploy this change to production now?',
      toolName: 'exec'
    })

    expect(record?.state).toBe('escalated')
    expect(record?.requiresHuman).toBe(true)
    expect(record?.authorityCategories).toContain('production-deployment')
    expect(notifyHuman).toHaveBeenCalledTimes(1)
  })

  it('escalates a payment approval straight to the human', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })

    const record = await service.raise({
      childTaskId: 'child-1',
      questionId: 'q1',
      kind: 'approval',
      questionText: 'Pay this vendor invoice of $4,200?'
    })

    expect(record?.state).toBe('escalated')
    expect(record?.authorityCategories).toContain('payment-operation')
  })

  describe('command-level authority (default-deny) — the actual commands a harness would ask to run', () => {
    const dangerousCommands = [
      'git push --force origin main',
      'rm -rf ~/project',
      'kubectl apply -f k8s/prod.yaml',
      'gh pr merge 650 --admin',
      'curl -X POST https://api.stripe.com/v1/charges',
      'terraform destroy',
      'npm publish'
    ]

    for (const command of dangerousCommands) {
      it(`escalates "${command}" straight to the human, never leaving it for the parent alone`, async () => {
        task({ id: 'parent-1' })
        task({ id: 'child-1', parent_task_id: 'parent-1' })

        const record = await service.raise({
          childTaskId: 'child-1',
          questionId: 'q1',
          kind: 'approval',
          questionText: `Run \`${command}\`?`,
          toolName: 'exec',
          command
        })

        expect(record?.state).toBe('escalated')
        expect(record?.requiresHuman).toBe(true)
        expect(notifyHuman).toHaveBeenCalledTimes(1)
      })
    }

    it('routes a safe, workspace-local command to the parent as usual', async () => {
      task({ id: 'parent-1' })
      task({ id: 'child-1', parent_task_id: 'parent-1' })

      const record = await service.raise({
        childTaskId: 'child-1',
        questionId: 'q1',
        kind: 'approval',
        questionText: 'Run the test suite?',
        toolName: 'exec',
        command: 'npm test'
      })

      expect(record?.state).toBe('pending_parent')
      expect(record?.requiresHuman).toBe(false)
    })
  })

  it('scrubs secret-shaped text out of the stored context excerpt', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })

    const record = await service.raise({
      childTaskId: 'child-1',
      questionId: 'q1',
      kind: 'question',
      questionText: 'Use this key?',
      contextExcerpt: 'api_key: sk-abcdefghijklmnopqrstuvwx should I use this?'
    })

    expect(record?.contextExcerpt).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(record?.contextExcerpt).toContain('[redacted]')
  })

  it('returns null for a child task that does not exist', async () => {
    const record = await service.raise({ childTaskId: 'missing', questionId: 'q1', kind: 'question', questionText: 'x' })
    expect(record).toBeNull()
  })
})

describe('ChildQuestionService.sweepEscalations', () => {
  it('escalates a pending question once its deadline has passed, and leaves one not yet due alone', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    task({ id: 'child-2', parent_task_id: 'parent-1' })

    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'question', questionText: 'Due soon' })
    await service.raise({ childTaskId: 'child-2', questionId: 'q2', kind: 'question', questionText: 'Due later' })

    now += DEFAULT_CHILD_QUESTION_ESCALATION_TIMEOUT_MS + 1
    const escalated = service.sweepEscalations()

    expect(escalated.map((r) => r.childTaskId).sort()).toEqual(['child-1', 'child-2'])
    expect(notifyHuman).toHaveBeenCalledTimes(2)
  })

  it('does not escalate a question the parent already answered', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })
    await service.answerFromParent('parent-1', 'child-1', 'q1', { approved: true })

    now += DEFAULT_CHILD_QUESTION_ESCALATION_TIMEOUT_MS + 1
    const escalated = service.sweepEscalations()

    expect(escalated).toHaveLength(0)
  })
})

describe('ChildQuestionService.answerFromParent', () => {
  it('answers an approval through the same adapter call the human UI uses, passing the question id as the harness requestId, and cancels the pending wake-up', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })

    const result = await service.answerFromParent('parent-1', 'child-1', 'q1', { approved: true })

    expect(result).toMatchObject({ success: true })
    expect(answerChildSession).toHaveBeenCalledWith('child-1', 'approval', { approved: true, answer: undefined, optionId: undefined }, 'q1')
    expect(cancelParentWakeup).toHaveBeenCalledWith('parent-1', 'child-1')
    expect(appendTranscriptNote).toHaveBeenCalledTimes(1)
    const record = store.getByChildAndQuestionId('child-1', 'q1')
    expect(record?.state).toBe('answered_by_parent')
    expect(record?.answeredBy).toBe('parent')
  })

  it('requires `approved` for an approval — it does not default to approve', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })

    const result = await service.answerFromParent('parent-1', 'child-1', 'q1', {})

    expect(result).toMatchObject({ error: expect.any(String) })
    expect(answerChildSession).not.toHaveBeenCalled()
    expect(store.getByChildAndQuestionId('child-1', 'q1')?.state).toBe('pending_parent')
  })

  it('rejects answering a question that is not a descendant of the caller', async () => {
    task({ id: 'parent-1' })
    task({ id: 'other-parent' })
    task({ id: 'child-1', parent_task_id: 'other-parent' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'question', questionText: 'x' })

    const result = await service.answerFromParent('parent-1', 'child-1', 'q1', { answer: 'y' })

    expect(result).toMatchObject({ error: expect.any(String) })
    expect(answerChildSession).not.toHaveBeenCalled()
  })

  it('rejects answering a question that was already escalated to the human', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Deploy this change to production now?' })

    // The record landed 'escalated' (out-of-authority approval) even though the
    // caller really is the parent — it just isn't the parent's call to make.
    const result = await service.answerFromParent('parent-1', 'child-1', 'q1', { approved: true })
    expect(result).toMatchObject({ error: expect.any(String) })
    expect(answerChildSession).not.toHaveBeenCalled()
  })

  it('rejects answering a question that the parent already answered', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })
    await service.answerFromParent('parent-1', 'child-1', 'q1', { approved: true })

    const second = await service.answerFromParent('parent-1', 'child-1', 'q1', { approved: false })
    expect(second).toMatchObject({ error: expect.any(String) })
  })

  it('reverts the claim when the adapter call itself fails, so the question is answerable again', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })
    answerChildSession.mockRejectedValueOnce(new Error('session gone'))

    const first = await service.answerFromParent('parent-1', 'child-1', 'q1', { approved: true })
    expect(first).toMatchObject({ error: expect.stringContaining('session gone') })
    expect(store.getByChildAndQuestionId('child-1', 'q1')?.state).toBe('pending_parent')

    answerChildSession.mockResolvedValueOnce(undefined)
    const second = await service.answerFromParent('parent-1', 'child-1', 'q1', { approved: true })
    expect(second).toMatchObject({ success: true })
  })

  it('two concurrent answerFromParent calls for the same question: only one reaches the adapter', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })

    let resolveAdapterCall: (() => void) | undefined
    answerChildSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveAdapterCall = resolve })
    )

    const callA = service.answerFromParent('parent-1', 'child-1', 'q1', { approved: true })
    // Give callA's claim a chance to land before callB starts.
    await new Promise((r) => setTimeout(r, 0))
    const callB = service.answerFromParent('parent-1', 'child-1', 'q1', { approved: false })

    const resultB = await callB
    expect(resultB).toMatchObject({ error: expect.any(String) })

    resolveAdapterCall?.()
    const resultA = await callA
    expect(resultA).toMatchObject({ success: true })

    expect(answerChildSession).toHaveBeenCalledTimes(1)
  })
})

describe('ChildQuestionService.answerAsHuman', () => {
  it('answers a pending_parent question as the human, attributing "human" (not "parent")', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })

    const result = await service.answerAsHuman('child-1', 'q1', { approved: true })

    expect(result).toMatchObject({ success: true })
    expect(answerChildSession).toHaveBeenCalledWith('child-1', 'approval', { approved: true }, 'q1')
    const record = store.getByChildAndQuestionId('child-1', 'q1')
    expect(record?.state).toBe('answered_by_human')
    expect(record?.answeredBy).toBe('human')
  })

  it('also answers an already-escalated question — a human can always answer, unlike the parent', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Deploy this change to production now?' })
    expect(store.getByChildAndQuestionId('child-1', 'q1')?.state).toBe('escalated')

    const result = await service.answerAsHuman('child-1', 'q1', { approved: true })

    expect(result).toMatchObject({ success: true })
  })

  it('falls back to the latest live question when no exact id is given', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'question', questionText: 'Which env?' })

    const result = await service.answerAsHuman('child-1', undefined, { approved: true, answer: 'staging' })

    expect(result).toMatchObject({ success: true })
    expect(answerChildSession).toHaveBeenCalledWith('child-1', 'question', { approved: true, answer: 'staging' }, 'q1')
  })

  it('returns null (not an error) when there is nothing live to answer — lets a generic caller fall through to its own default behavior', async () => {
    const result = await service.answerAsHuman('no-such-child', undefined, { approved: true })
    expect(result).toBeNull()
    expect(answerChildSession).not.toHaveBeenCalled()
  })

  it('a concurrent parent answer and human answer: only one reaches the adapter', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })

    let resolveAdapterCall: (() => void) | undefined
    answerChildSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveAdapterCall = resolve })
    )

    const parentCall = service.answerFromParent('parent-1', 'child-1', 'q1', { approved: true })
    await new Promise((r) => setTimeout(r, 0))
    const humanCall = service.answerAsHuman('child-1', 'q1', { approved: false })

    const humanResult = await humanCall
    expect(humanResult).toMatchObject({ error: expect.any(String) })

    resolveAdapterCall?.()
    const parentResult = await parentCall
    expect(parentResult).toMatchObject({ success: true })

    expect(answerChildSession).toHaveBeenCalledTimes(1)
    expect(store.getByChildAndQuestionId('child-1', 'q1')?.answeredBy).toBe('parent')
  })
})

describe('ChildQuestionService.escalateToUser', () => {
  it('lets the parent explicitly hand a question to the human, with a note', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Rotate the API key?' })

    const result = service.escalateToUser('parent-1', 'child-1', 'q1', 'This needs a human call.')

    expect(result).toMatchObject({ success: true })
    expect(notifyHuman).toHaveBeenCalledTimes(1)
    const record = store.getByChildAndQuestionId('child-1', 'q1')
    expect(record?.state).toBe('escalated')
    expect(record?.note).toBe('This needs a human call.')
  })
})

describe('ChildQuestionService.getLiveForChild / cancelLiveForChild', () => {
  it('returns the current live question for a child', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })

    expect(service.getLiveForChild('child-1')?.questionId).toBe('q1')
  })

  it('cancels a stale live question when the child turn ends without it ever being answered', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })

    const cancelledCount = service.cancelLiveForChild('child-1')

    expect(cancelledCount).toBe(1)
    expect(store.getByChildAndQuestionId('child-1', 'q1')?.state).toBe('cancelled')
    expect(cancelParentWakeup).toHaveBeenCalledWith('parent-1', 'child-1')
    expect(service.getLiveForChild('child-1')).toBeNull()
  })

  it('cancelling leaves a just-raised newer question (exceptQuestionId) alone — a superseded request id does not cancel the new one', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Old request' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q2', kind: 'approval', questionText: 'New request' })

    service.cancelLiveForChild('child-1', 'q2')

    expect(store.getByChildAndQuestionId('child-1', 'q1')?.state).toBe('cancelled')
    expect(store.getByChildAndQuestionId('child-1', 'q2')?.state).toBe('pending_parent')
  })

  it('a stale cancelled row no longer makes wait_for_subtasks-style "any live question" checks return true', async () => {
    task({ id: 'parent-1' })
    task({ id: 'child-1', parent_task_id: 'parent-1' })
    await service.raise({ childTaskId: 'child-1', questionId: 'q1', kind: 'approval', questionText: 'Run tests?' })
    service.cancelLiveForChild('child-1')

    const live = service.listForChild('child-1').filter((r) => r.state === 'pending_parent' || r.state === 'escalated')
    expect(live).toHaveLength(0)
  })
})
