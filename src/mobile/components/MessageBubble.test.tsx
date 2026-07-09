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

  it('shows tool descriptions in compact rows and exact commands in expanded details', () => {
    const command = `cd "/Users/dmitryvedenyapin/Library/Application Support/20x/workspaces/vebrwpyobv88637krcachtxa/workflow-builder" && git add packages/ui/app/business-context/graph/page.tsx && git commit -q -F - <<'MSG'
fix(ui): move custom-property editor from Overview into the Properties tab

The "add custom property" controls were on the Overview (main) tab, so users
who went to Properties to add a field saw only the read-only cube params.
MSG
git push 2>&1 | tail -2`

    const toolMessage: AgentMessage = {
      id: 'tool-description',
      role: 'assistant',
      content: 'Bash',
      timestamp: new Date('2026-03-10T00:00:00.000Z'),
      partType: 'tool',
      tool: {
        name: 'Bash',
        status: 'success',
        input: JSON.stringify({
          command,
          description: 'Commit and push placement fix'
        }, null, 2),
        output: 'pass'
      }
    }

    const { getByRole, queryByText, getByText } = render(<MessageBubble message={toolMessage} />)
    const toolButton = getByRole('button', { name: /Bash Commit and push placement fix/i })
    expect(queryByText(/workflow-builder/)).toBeNull()
    expect(queryByText('Command')).toBeNull()

    fireEvent.click(toolButton)

    expect(getByText('Command')).toBeTruthy()
    expect(getByText((_, element) => element?.tagName === 'PRE' && element.textContent === command)).toBeTruthy()
  })

  it('shows only filenames for file editing tool subtitles', () => {
    const filePath = '/Users/dmitryvedenyapin/Library/Application Support/20x/workspaces/vebrwpyobv88637krcachtxa/workflow-builder/packages/ui/app/business-context/graph/page.tsx'

    const toolMessage: AgentMessage = {
      id: 'tool-edit',
      role: 'assistant',
      content: 'Edit',
      timestamp: new Date('2026-03-10T00:00:00.000Z'),
      partType: 'tool',
      tool: {
        name: 'Edit',
        status: 'success',
        input: JSON.stringify({
          replace_all: false,
          file_path: filePath,
          old_string: '              {/* Properties Tab */}',
          new_string: '              {/* Properties Tab */}'
        }, null, 2),
        output: 'updated'
      }
    }

    const { getByRole, queryByRole } = render(<MessageBubble message={toolMessage} />)

    expect(getByRole('button', { name: /Edit page\.tsx/i })).toBeTruthy()
    expect(queryByRole('button', { name: /workflow-builder/i })).toBeNull()
  })

  it('shows only filenames for read tool subtitles', () => {
    const filePath = '/Users/dmitryvedenyapin/Library/Application Support/20x/workspaces/vebrwpyobv88637krcachtxa/workflow-builder/packages/cubejs/lib/custom-dimensions.js'

    const toolMessage: AgentMessage = {
      id: 'tool-read',
      role: 'assistant',
      content: 'Read',
      timestamp: new Date('2026-03-10T00:00:00.000Z'),
      partType: 'tool',
      tool: {
        name: 'Read',
        status: 'success',
        input: JSON.stringify({ file_path: filePath }, null, 2),
        output: 'const customDimensions = []'
      }
    }

    const { getByRole, queryByRole } = render(<MessageBubble message={toolMessage} />)

    expect(getByRole('button', { name: /Read custom-dimensions\.js/i })).toBeTruthy()
    expect(queryByRole('button', { name: /workflow-builder/i })).toBeNull()
  })
})
