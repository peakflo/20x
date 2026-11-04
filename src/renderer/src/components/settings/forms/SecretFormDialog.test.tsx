import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SecretFormDialog } from './SecretFormDialog'

afterEach(() => cleanup())

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Secret' } })
  fireEvent.change(screen.getByLabelText('Environment Variable'), { target: { value: 'MY_SECRET' } })
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'super-secret-value' } })
}

describe('SecretFormDialog', () => {
  // Re-review (P2): used to close unconditionally right after firing
  // onSubmit, regardless of whether the save actually succeeded.
  it('closes when onSubmit resolves true (success)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true)
    const onClose = vi.fn()
    render(<SecretFormDialog open={true} onClose={onClose} onSubmit={onSubmit} />)

    fillRequiredFields()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('stays open when onSubmit resolves false (failure) — the form and error stay visible', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false)
    const onClose = vi.fn()
    render(<SecretFormDialog open={true} onClose={onClose} onSubmit={onSubmit} />)

    fillRequiredFields()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    // Give any erroneous close a chance to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 10))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Name')).toHaveValue('My Secret')
  })

  it('disables the submit button while the submit is in flight', async () => {
    let resolveSubmit: (value: boolean) => void = () => {}
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSubmit = resolve
        })
    )
    render(<SecretFormDialog open={true} onClose={vi.fn()} onSubmit={onSubmit} />)

    fillRequiredFields()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled())
    await act(async () => {
      resolveSubmit(true)
      await Promise.resolve()
    })
  })
})
