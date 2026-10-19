import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChildQuestionRecord } from '@shared/child-questions'

const { listMock, answerMock, answerAsHumanMock, escalateMock, eventHandlers } = vi.hoisted(() => ({
  listMock: vi.fn(),
  answerMock: vi.fn(),
  answerAsHumanMock: vi.fn(),
  escalateMock: vi.fn(),
  eventHandlers: new Map<string, Set<(payload: unknown) => void>>()
}))

vi.mock('../api/client', () => ({
  api: {
    childQuestions: {
      list: (...args: unknown[]) => listMock(...args),
      answer: (...args: unknown[]) => answerMock(...args),
      answerAsHuman: (...args: unknown[]) => answerAsHumanMock(...args),
      escalate: (...args: unknown[]) => escalateMock(...args)
    }
  }
}))

vi.mock('../api/websocket', () => ({
  onEvent: (type: string, handler: (payload: unknown) => void) => {
    if (!eventHandlers.has(type)) eventHandlers.set(type, new Set())
    eventHandlers.get(type)!.add(handler)
    return () => eventHandlers.get(type)?.delete(handler)
  }
}))

function emit(type: string, payload: unknown): void {
  for (const handler of eventHandlers.get(type) ?? []) handler(payload)
}

import { ChildQuestionsNotice } from './ChildQuestionsNotice'
import { CHILD_QUESTION_RAISED_CHANNEL } from '@shared/child-questions'

function record(overrides: Partial<ChildQuestionRecord> = {}): ChildQuestionRecord {
  return {
    id: 'q-1',
    childTaskId: 'child-1',
    parentTaskId: 'parent-1',
    questionId: 'question-1',
    kind: 'approval',
    questionText: 'Deploy to production?',
    options: null,
    toolName: 'bash',
    command: 'npm run deploy',
    contextExcerpt: null,
    requiresHuman: false,
    authorityCategories: [],
    state: 'pending_parent',
    answer: null,
    optionId: null,
    note: null,
    answeredBy: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    escalateAt: Date.now() + 60_000,
    escalatedAt: null,
    answeredAt: null,
    ...overrides
  }
}

beforeEach(() => {
  cleanup()
  listMock.mockReset()
  answerMock.mockReset()
  answerAsHumanMock.mockReset()
  escalateMock.mockReset()
  eventHandlers.clear()
})

describe('ChildQuestionsNotice', () => {
  it('renders nothing when there are no questions', async () => {
    listMock.mockResolvedValue({ as_parent: [], as_child: [] })
    render(<ChildQuestionsNotice taskId="parent-1" />)
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('parent-1'))
    expect(screen.queryByTestId('child-questions-notice')).toBeNull()
  })

  it('shows a waiting-for-parent card with Answer and Escalate actions', async () => {
    listMock.mockResolvedValue({ as_parent: [record()], as_child: [] })
    render(<ChildQuestionsNotice taskId="parent-1" />)

    expect(await screen.findByText('Waiting for parent')).toBeTruthy()
    expect(screen.getByText('Deploy to production?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Escalate to me' })).toBeTruthy()
  })

  it('shows an escalated card without the escalate action', async () => {
    listMock.mockResolvedValue({ as_parent: [record({ state: 'escalated' })], as_child: [] })
    render(<ChildQuestionsNotice taskId="parent-1" />)

    expect(await screen.findByText('Escalated to you')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Escalate to me' })).toBeNull()
  })

  it('answers a question from the phone and attributes it to the human, not the parent', async () => {
    // A human tapping this button on the phone is a human decision — even
    // though the card is shown on the parent task — so it must claim
    // through answerAsHuman (attributed "Answered by you"), never `answer`
    // (which speaks for the parent agent itself).
    listMock.mockResolvedValue({ as_parent: [record()], as_child: [] })
    answerAsHumanMock.mockResolvedValue({
      success: true,
      record: record({ state: 'answered_by_human', answeredBy: 'human', answer: 'Approved', optionId: null })
    })
    render(<ChildQuestionsNotice taskId="parent-1" />)

    const approveButton = await screen.findByRole('button', { name: 'Approve' })
    fireEvent.click(approveButton)

    await waitFor(() => expect(answerAsHumanMock).toHaveBeenCalledWith('child-1', 'question-1', { approved: true }))
    expect(answerMock).not.toHaveBeenCalled()
    expect(await screen.findByText('Answered by you: Approved')).toBeTruthy()
  })

  it('answers an already-escalated question from the phone too (answer, parent-only, would refuse this one)', async () => {
    listMock.mockResolvedValue({ as_parent: [record({ state: 'escalated' })], as_child: [] })
    answerAsHumanMock.mockResolvedValue({
      success: true,
      record: record({ state: 'answered_by_human', answeredBy: 'human', answer: 'Approved', optionId: null })
    })
    render(<ChildQuestionsNotice taskId="parent-1" />)

    const approveButton = await screen.findByRole('button', { name: 'Approve' })
    fireEvent.click(approveButton)

    await waitFor(() => expect(answerAsHumanMock).toHaveBeenCalledWith('child-1', 'question-1', { approved: true }))
    expect(await screen.findByText('Answered by you: Approved')).toBeTruthy()
  })

  it('refreshes the list on a live push event without a manual reload', async () => {
    listMock.mockResolvedValue({ as_parent: [], as_child: [] })
    render(<ChildQuestionsNotice taskId="parent-1" />)
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    listMock.mockResolvedValue({ as_parent: [record()], as_child: [] })
    act(() => { emit(CHILD_QUESTION_RAISED_CHANNEL, { taskId: 'child-1', question: record() }) })

    expect(await screen.findByText('Waiting for parent')).toBeTruthy()
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('shows a read-only card for a question this task itself raised', async () => {
    listMock.mockResolvedValue({
      as_parent: [],
      as_child: [
        record({ id: 'q-2', childTaskId: 'parent-1', parentTaskId: 'grandparent-1', state: 'answered_by_human', answeredBy: 'human', answer: 'Yes, go ahead' })
      ]
    })
    render(<ChildQuestionsNotice taskId="parent-1" />)

    expect(await screen.findByTestId('child-question-card-readonly')).toBeTruthy()
    expect(screen.getByText('Answered by you: Yes, go ahead')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
