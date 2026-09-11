import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { FeedbackDialog } from './FeedbackDialog'

describe('FeedbackDialog', () => {
  const onSubmit = vi.fn<(rating: number, comment: string, completeAtSource: boolean) => void>()
  const onSkip = vi.fn<(completeAtSource: boolean) => void>()
  const onCancel = vi.fn<() => void>()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Without this the previous test's dialog stays in the DOM and testid
  // lookups match more than one element.
  afterEach(cleanup)

  // Local tasks do not need a source choice.
  it('does not offer source choices for local tasks', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    expect(screen.queryByTestId('source-completion-choice')).toBeNull()
    expect(screen.queryByTestId('choice-complete-manually')).toBeNull()
    expect(screen.queryByTestId('choice-complete-at-source')).toBeNull()
  })

  function getDialog() {
    return screen.getByRole('dialog')
  }

  it('renders when open', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    expect(screen.getByText('Session Feedback')).toBeInTheDocument()
  })

  it('calls onSkip when Skip button is clicked', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    const dialog = getDialog()
    fireEvent.click(within(dialog).getByText('Skip'))
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('calls onCancel (not onSkip) when the close (X) button is clicked', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    const closeButton = screen.getByRole('button', { name: /close/i })
    fireEvent.click(closeButton)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSkip).not.toHaveBeenCalled()
  })

  it('does not call onSubmit when no rating is selected', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    const dialog = getDialog()
    expect(within(dialog).getByText('Submit Feedback')).toBeDisabled()
  })

  it('calls onSubmit with rating and comment when submitted', () => {
    render(<FeedbackDialog open={true} sourceName="Session Feedback" completionDescription="Action at Session Feedback: approve." onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    const dialog = getDialog()
    expect(within(dialog).getByText('Action at Session Feedback: approve.')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    // Click the 4th star
    const starButtons = within(dialog).getAllByRole('button').filter(btn =>
      btn.getAttribute('type') === 'button' && btn.querySelector('svg')
    )
    fireEvent.click(starButtons[3])

    // Type a comment
    const textarea = within(dialog).getByPlaceholderText('Optional feedback...')
    fireEvent.change(textarea, { target: { value: 'Great session!' } })

    // Submit
    fireEvent.click(within(dialog).getByText('Submit Feedback'))
    expect(onSubmit).toHaveBeenCalledWith(4, 'Great session!', true)
  })
})

describe('manual feedback completion', () => {
  afterEach(cleanup)
  it.each(['Skip', 'Submit Feedback'])('keeps the manual choice through %s', (button) => {
    const onSubmit = vi.fn()
    const onSkip = vi.fn()
    render(<FeedbackDialog open sourceName="Session Feedback" onSubmit={onSubmit} onSkip={onSkip} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: "I'll do it manually" }))
    expect(screen.getByText('Complete in 20x only. The source record will not change.')).toBeInTheDocument()
    const stars = within(screen.getByRole('dialog')).getAllByRole('button').filter(button => button.querySelector('svg'))
    fireEvent.click(stars[3])
    fireEvent.click(screen.getByRole('button', { name: button }))
    if (button === 'Skip') expect(onSkip).toHaveBeenCalledWith(false)
    else expect(onSubmit).toHaveBeenCalledWith(4, '', false)
  })
})
