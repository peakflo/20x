import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MessageBubble } from './MessageBubble'
import type { AgentMessage } from '../stores/agent-store'

function makeQuestionMessage(): AgentMessage {
  return {
    id: 'q-1',
    role: 'assistant',
    content: 'Approval required',
    timestamp: new Date('2026-03-10T00:00:00.000Z'),
    partType: 'question',
    tool: {
      name: 'permission',
      status: 'pending',
      questions: [
        {
          header: 'Permission',
          question: 'Allow write?',
          options: [{ label: 'Yes', description: 'Allow once' }]
        }
      ]
    }
  }
}

describe('MessageBubble question actions', () => {
  afterEach(() => {
    cleanup()
  })
  it('does not allow submitting non-active questions', () => {
    const onAnswer = vi.fn()
    const { queryByText, getByText } = render(
      <MessageBubble message={makeQuestionMessage()} onAnswer={onAnswer} canAnswerQuestion={false} />
    )

    fireEvent.click(getByText('Yes'))

    expect(queryByText('Submit')).toBeNull()
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('submits active question once', () => {
    const onAnswer = vi.fn()
    const { getByText, queryByText } = render(
      <MessageBubble message={makeQuestionMessage()} onAnswer={onAnswer} canAnswerQuestion={true} />
    )

    fireEvent.click(getByText('Yes'))
    fireEvent.click(getByText('Submit'))

    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith('Yes')
    expect(queryByText('Submit')).toBeNull()
  })
})
