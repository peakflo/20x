/**
 * Unit tests for QuestionMessage multi-question behavior in AgentTranscriptPanel
 *
 * Verifies:
 * - Single question: immediate submit on option click
 * - Multiple questions: deferred submit via "Submit answers" button
 * - Submit button disabled until all questions answered
 * - Users can toggle/change answers before submitting
 * - After submission, options are disabled
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AgentTranscriptPanel } from './AgentTranscriptPanel'
import type { AgentMessage } from '@/stores/agent-store'

// ── Helpers ──────────────────────────────────────────────────

function makeQuestionMessage(
  questions: Array<{ header?: string; question: string; options: Array<{ label: string; description?: string }> }>,
  id = 'q-1'
): AgentMessage {
  return {
    id,
    role: 'assistant',
    content: 'Question',
    timestamp: new Date('2026-02-21T12:00:00Z'),
    partType: 'question',
    tool: {
      name: 'AskUserQuestion',
      status: 'running',
      questions: questions.map((q) => ({
        header: q.header ?? '',
        question: q.question,
        options: q.options.map((o) => ({ label: o.label, description: o.description ?? '' }))
      }))
    }
  }
}

const noop = () => {}

/** Render the panel and return scoped query helpers for the question card. */
function renderQuestion(msg: AgentMessage, onSend: (message: string) => void) {
  const result = render(
    <AgentTranscriptPanel
      messages={[msg]}
      status="waiting_approval"
      onStop={noop}
      onSend={onSend}
    />
  )
  // The question card is the first .rounded-md inside the scroll area
  const questionCard = result.container.querySelector('.border-primary\\/30')!
  return { ...result, card: within(questionCard as HTMLElement) }
}

// ── Tests ────────────────────────────────────────────────────

describe('QuestionMessage', () => {
  let onSend: ReturnType<typeof vi.fn<(message: string) => void>>

  beforeEach(() => {
    onSend = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  // ── Single question ────────────────────────────────────────

  describe('Single question (immediate submit)', () => {
    const singleQuestionMsg = makeQuestionMessage([
      {
        header: 'Auth method',
        question: 'Which authentication method should we use?',
        options: [
          { label: 'JWT', description: 'JSON Web Tokens' },
          { label: 'OAuth', description: 'OAuth 2.0 flow' },
          { label: 'Session', description: 'Server-side sessions' }
        ]
      }
    ])

    it('renders the question text and all options', () => {
      const { card } = renderQuestion(singleQuestionMsg, onSend)

      expect(card.getByText('Which authentication method should we use?')).toBeInTheDocument()
      expect(card.getByText('JWT')).toBeInTheDocument()
      expect(card.getByText('OAuth')).toBeInTheDocument()
      expect(card.getByText('Session')).toBeInTheDocument()
    })

    it('renders option descriptions', () => {
      const { card } = renderQuestion(singleQuestionMsg, onSend)

      expect(card.getByText('JSON Web Tokens')).toBeInTheDocument()
      expect(card.getByText('OAuth 2.0 flow')).toBeInTheDocument()
    })

    it('renders the header', () => {
      const { card } = renderQuestion(singleQuestionMsg, onSend)

      expect(card.getByText('Auth method')).toBeInTheDocument()
    })

    it('submits immediately when an option is clicked', () => {
      const { card } = renderQuestion(singleQuestionMsg, onSend)

      fireEvent.click(card.getByText('JWT'))

      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledWith('JWT')
    })

    it('does NOT show a "Submit answers" button', () => {
      const { card } = renderQuestion(singleQuestionMsg, onSend)

      expect(card.queryByText('Submit answers')).not.toBeInTheDocument()
    })

    it('disables all options after submission', () => {
      const { card } = renderQuestion(singleQuestionMsg, onSend)

      fireEvent.click(card.getByText('JWT'))

      // Clicking another option should not submit again
      fireEvent.click(card.getByText('OAuth'))
      expect(onSend).toHaveBeenCalledTimes(1)
    })
  })

  // ── Multiple questions ─────────────────────────────────────

  describe('Multiple questions (deferred submit)', () => {
    const multiQuestionMsg = makeQuestionMessage([
      {
        header: 'Library',
        question: 'Which library should we use for date formatting?',
        options: [
          { label: 'date-fns', description: 'Lightweight and modular' },
          { label: 'dayjs', description: 'Moment.js alternative' }
        ]
      },
      {
        header: 'Approach',
        question: 'Which approach for state management?',
        options: [
          { label: 'Redux', description: 'Predictable state container' },
          { label: 'Zustand', description: 'Lightweight store' },
          { label: 'Context', description: 'Built-in React API' }
        ]
      }
    ])

    it('renders all questions and their options', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      // Question texts
      expect(card.getByText('Which library should we use for date formatting?')).toBeInTheDocument()
      expect(card.getByText('Which approach for state management?')).toBeInTheDocument()

      // All options from both questions
      expect(card.getByText('date-fns')).toBeInTheDocument()
      expect(card.getByText('dayjs')).toBeInTheDocument()
      expect(card.getByText('Redux')).toBeInTheDocument()
      expect(card.getByText('Zustand')).toBeInTheDocument()
      expect(card.getByText('Context')).toBeInTheDocument()
    })

    it('shows "Submit answers" button', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      expect(card.getByText('Submit answers')).toBeInTheDocument()
    })

    it('does NOT submit immediately when an option is clicked', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      fireEvent.click(card.getByText('date-fns'))

      expect(onSend).not.toHaveBeenCalled()
    })

    it('submit button is disabled until all questions are answered', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      const submitBtn = card.getByText('Submit answers').closest('button')!
      expect(submitBtn).toBeDisabled()

      // Answer only the first question
      fireEvent.click(card.getByText('date-fns'))
      expect(submitBtn).toBeDisabled()

      // Answer the second question too — now button should be enabled
      fireEvent.click(card.getByText('Zustand'))
      expect(submitBtn).not.toBeDisabled()
    })

    it('submits combined answers when "Submit answers" is clicked', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      fireEvent.click(card.getByText('dayjs'))
      fireEvent.click(card.getByText('Redux'))

      const submitBtn = card.getByText('Submit answers').closest('button')!
      fireEvent.click(submitBtn)

      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledWith('dayjs | Redux')
    })

    it('allows changing an answer before submitting', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      // Select initial answers
      fireEvent.click(card.getByText('date-fns'))
      fireEvent.click(card.getByText('Redux'))

      // Change first answer
      fireEvent.click(card.getByText('dayjs'))

      const submitBtn = card.getByText('Submit answers').closest('button')!
      fireEvent.click(submitBtn)

      expect(onSend).toHaveBeenCalledWith('dayjs | Redux')
    })

    it('allows deselecting an answer by clicking it again', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      // Select and deselect first question's answer
      fireEvent.click(card.getByText('date-fns'))
      fireEvent.click(card.getByText('date-fns')) // deselect

      // Answer both questions
      fireEvent.click(card.getByText('dayjs'))
      fireEvent.click(card.getByText('Context'))

      const submitBtn = card.getByText('Submit answers').closest('button')!
      fireEvent.click(submitBtn)

      expect(onSend).toHaveBeenCalledWith('dayjs | Context')
    })

    it('disables all options after submission', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      fireEvent.click(card.getByText('date-fns'))
      fireEvent.click(card.getByText('Zustand'))

      const submitBtn = card.getByText('Submit answers').closest('button')!
      fireEvent.click(submitBtn)

      // Should show "Submitted" state
      expect(card.getByText('Submitted')).toBeInTheDocument()
      expect(card.queryByText('Submit answers')).not.toBeInTheDocument()

      // Clicking another option should not trigger anything
      fireEvent.click(card.getByText('dayjs'))
      expect(onSend).toHaveBeenCalledTimes(1) // still just the one submit
    })

    it('submit button does nothing when clicked while disabled', () => {
      const { card } = renderQuestion(multiQuestionMsg, onSend)

      // Don't answer any questions, just click submit
      const submitBtn = card.getByText('Submit answers').closest('button')!
      fireEvent.click(submitBtn)

      expect(onSend).not.toHaveBeenCalled()
    })
  })

  // ── Three questions ────────────────────────────────────────

  describe('Three questions', () => {
    const threeQuestionMsg = makeQuestionMessage([
      {
        question: 'Question 1?',
        options: [{ label: 'A1' }, { label: 'B1' }]
      },
      {
        question: 'Question 2?',
        options: [{ label: 'A2' }, { label: 'B2' }]
      },
      {
        question: 'Question 3?',
        options: [{ label: 'A3' }, { label: 'B3' }]
      }
    ])

    it('requires all three questions answered before enabling submit', () => {
      const { card } = renderQuestion(threeQuestionMsg, onSend)

      const submitBtn = card.getByText('Submit answers').closest('button')!

      // Answer only 2 of 3
      fireEvent.click(card.getByText('A1'))
      fireEvent.click(card.getByText('B2'))
      expect(submitBtn).toBeDisabled()

      // Answer the third
      fireEvent.click(card.getByText('A3'))
      expect(submitBtn).not.toBeDisabled()

      fireEvent.click(submitBtn)
      expect(onSend).toHaveBeenCalledWith('A1 | B2 | A3')
    })
  })

  // ── Edge cases ─────────────────────────────────────────────

  describe('Edge cases', () => {
    it('handles question with no options gracefully', () => {
      const msg = makeQuestionMessage([
        { question: 'Empty options?', options: [] },
        { question: 'Has options?', options: [{ label: 'Yes' }] }
      ])

      const { card } = renderQuestion(msg, onSend)

      expect(card.getByText('Empty options?')).toBeInTheDocument()
      expect(card.getByText('Has options?')).toBeInTheDocument()
    })

    it('renders question without onSend callback (read-only)', () => {
      const msg = makeQuestionMessage([
        { question: 'Read-only?', options: [{ label: 'Yes' }] }
      ])

      const { container } = render(
        <AgentTranscriptPanel
          messages={[msg]}
          status="idle"
          onStop={noop}
        />
      )

      expect(within(container).getByText('Read-only?')).toBeInTheDocument()
    })
  })
})
