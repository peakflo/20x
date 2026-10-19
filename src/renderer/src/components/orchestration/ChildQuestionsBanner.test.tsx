import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChildQuestionRecord } from '@shared/child-questions'

let pushRaised: ((event: { taskId: string; question: ChildQuestionRecord }) => void) | null = null

const listForParent = vi.fn()
const listForChild = vi.fn()
const answerMock = vi.fn()
const escalateMock = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  childQuestionsApi: {
    listForParent: (...args: unknown[]) => listForParent(...args),
    listForChild: (...args: unknown[]) => listForChild(...args),
    answer: (...args: unknown[]) => answerMock(...args),
    escalate: (...args: unknown[]) => escalateMock(...args)
  },
  onChildQuestionRaised: (cb: (event: { taskId: string; question: ChildQuestionRecord }) => void) => {
    pushRaised = cb
    return () => { pushRaised = null }
  },
  onChildQuestionAnswered: () => () => undefined,
  onChildQuestionEscalated: () => () => undefined
}))

import { ChildQuestionsBanner } from './ChildQuestionsBanner'

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
  listForParent.mockReset()
  listForChild.mockReset()
  answerMock.mockReset()
  escalateMock.mockReset()
  pushRaised = null
})

describe('ChildQuestionsBanner', () => {
  it('renders nothing when there are no questions', async () => {
    listForParent.mockResolvedValue([])
    listForChild.mockResolvedValue([])
    render(<ChildQuestionsBanner taskId="parent-1" />)
    await waitFor(() => expect(listForParent).toHaveBeenCalledWith('parent-1'))
    expect(screen.queryByTestId('child-questions-banner')).not.toBeInTheDocument()
  })

  it('shows a waiting-for-parent card with Answer and Escalate actions', async () => {
    listForParent.mockResolvedValue([record()])
    listForChild.mockResolvedValue([])
    render(<ChildQuestionsBanner taskId="parent-1" />)

    expect(await screen.findByText('Waiting for parent')).toBeInTheDocument()
    expect(screen.getByText('Deploy to production?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Escalate to me' })).toBeInTheDocument()
  })

  it('shows an escalated card without the escalate action', async () => {
    listForParent.mockResolvedValue([record({ state: 'escalated' })])
    listForChild.mockResolvedValue([])
    render(<ChildQuestionsBanner taskId="parent-1" />)

    expect(await screen.findByText('Escalated to you')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Escalate to me' })).not.toBeInTheDocument()
  })

  it('answers a question and shows it was answered by Mastermind', async () => {
    listForParent.mockResolvedValue([record()])
    listForChild.mockResolvedValue([])
    answerMock.mockResolvedValue({
      success: true,
      record: record({ state: 'answered_by_parent', answeredBy: 'parent', answer: null, optionId: null })
    })
    render(<ChildQuestionsBanner taskId="parent-1" />)

    const approveButton = await screen.findByRole('button', { name: 'Approve' })
    fireEvent.click(approveButton)

    await waitFor(() => expect(answerMock).toHaveBeenCalledWith('parent-1', 'child-1', 'question-1', { approved: true }))
    expect(await screen.findByText('Answered by Mastermind')).toBeInTheDocument()
  })

  it('refreshes the list on a live push event without a manual reload', async () => {
    listForParent.mockResolvedValue([])
    listForChild.mockResolvedValue([])
    render(<ChildQuestionsBanner taskId="parent-1" />)
    await waitFor(() => expect(listForParent).toHaveBeenCalledTimes(1))

    listForParent.mockResolvedValue([record()])
    act(() => { pushRaised?.({ taskId: 'child-1', question: record() }) })

    expect(await screen.findByText('Waiting for parent')).toBeInTheDocument()
    expect(listForParent).toHaveBeenCalledTimes(2)
  })

  it('shows a read-only card for a question this task itself raised', async () => {
    listForParent.mockResolvedValue([])
    listForChild.mockResolvedValue([
      record({ id: 'q-2', childTaskId: 'parent-1', parentTaskId: 'grandparent-1', state: 'answered_by_human', answeredBy: 'human', answer: 'Yes, go ahead' })
    ])
    render(<ChildQuestionsBanner taskId="parent-1" />)

    expect(await screen.findByTestId('child-question-card-readonly')).toBeInTheDocument()
    expect(screen.getByText('Answered by you: Yes, go ahead')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
