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

describe('MessageBubble message layout', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders agent text full width without card bubble chrome while keeping user bubbles', () => {
    const assistantMessage: AgentMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Here is the result',
      timestamp: new Date('2026-03-10T00:00:00.000Z'),
      partType: 'text'
    }
    const userMessage: AgentMessage = {
      id: 'user-1',
      role: 'user',
      content: 'Thanks',
      timestamp: new Date('2026-03-10T00:00:00.000Z'),
      partType: 'text'
    }

    const { rerender } = render(<MessageBubble message={assistantMessage} />)
    const assistantBubble = document.querySelector('.overflow-hidden')

    expect(assistantBubble?.classList.contains('w-full')).toBe(true)
    expect(assistantBubble?.classList.contains('bg-card')).toBe(false)
    expect(assistantBubble?.classList.contains('rounded-md')).toBe(false)

    rerender(<MessageBubble message={userMessage} />)
    const userBubble = document.querySelector('.overflow-hidden')

    expect(userBubble?.classList.contains('rounded-md')).toBe(true)
    expect(userBubble?.classList.contains('bg-secondary')).toBe(true)
  })

  it('renders tool calls as compact expandable rows without a card bubble', () => {
    const toolMessage: AgentMessage = {
      id: 'tool-1',
      role: 'assistant',
      content: 'Bash',
      timestamp: new Date('2026-03-10T00:00:00.000Z'),
      partType: 'tool',
      tool: {
        name: 'Bash',
        status: 'success',
        title: 'pnpm test',
        input: 'pnpm test',
        output: 'pass'
      }
    }

    const { getByRole, queryByText, getByText } = render(<MessageBubble message={toolMessage} />)
    const toolButton = getByRole('button', { name: /Bash pnpm test/i })
    const toolContainer = toolButton.parentElement

    expect(toolContainer?.classList.contains('w-full')).toBe(true)
    expect(toolContainer?.classList.contains('bg-card')).toBe(false)
    expect(toolContainer?.classList.contains('rounded-md')).toBe(false)
    expect(queryByText('Output')).toBeNull()

    fireEvent.click(toolButton)

    expect(getByText('Output')).toBeTruthy()
    expect(getByText('pass')).toBeTruthy()
  })
})
