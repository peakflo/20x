import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { FeedbackDialog } from './FeedbackDialog'

describe('FeedbackDialog', () => {
  const onSubmit = vi.fn<(rating: number, comment: string) => void>()
  const onSkip = vi.fn<() => void>()
  const onCancel = vi.fn<() => void>()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Without this the previous test's dialog stays in the DOM and testid
  // lookups match more than one element.
  afterEach(cleanup)

  it('does not offer local-only completion for a Workflo task', () => {
    render(<FeedbackDialog open sourceName="Workflo" serverManaged onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    expect(screen.queryByTestId('choice-complete-manually')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Skip'))
    expect(onSkip).toHaveBeenCalledWith()
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
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    const dialog = getDialog()

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
    expect(onSubmit).toHaveBeenCalledWith(4, 'Great session!')
  })

  // ── Source completion choice ──────────────────────────────

  it('hides the source choice for a task with no source', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    expect(screen.queryByTestId('source-completion-choice')).toBeNull()
  })

  it('never offers local-only completion for any source', () => {
    render(<FeedbackDialog open sourceName="Notion" onSubmit={onSubmit} onSkip={onSkip} onCancel={onCancel} />)
    expect(screen.queryByTestId('choice-complete-manually')).toBeNull()
    fireEvent.click(screen.getByText('Skip'))
    expect(onSkip).toHaveBeenCalledWith()
  })
})
