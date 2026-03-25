import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { FeedbackDialog } from './FeedbackDialog'

describe('FeedbackDialog', () => {
  const onSubmit = vi.fn<(rating: number, comment: string) => void>()
  const onSkip = vi.fn<() => void>()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function getDialog() {
    return screen.getByRole('dialog')
  }

  it('renders when open', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} />)
    expect(screen.getByText('Session Feedback')).toBeInTheDocument()
  })

  it('calls onSkip when Skip button is clicked', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} />)
    const dialog = getDialog()
    fireEvent.click(within(dialog).getByText('Skip'))
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('calls onSkip when the close (X) button is clicked', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} />)
    const closeButton = screen.getByRole('button', { name: /close/i })
    fireEvent.click(closeButton)
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('does not call onSubmit when no rating is selected', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} />)
    const dialog = getDialog()
    expect(within(dialog).getByText('Submit Feedback')).toBeDisabled()
  })

  it('calls onSubmit with rating and comment when submitted', () => {
    render(<FeedbackDialog open={true} onSubmit={onSubmit} onSkip={onSkip} />)
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
})
