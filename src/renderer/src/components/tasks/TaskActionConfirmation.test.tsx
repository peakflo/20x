import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TaskConfirmation } from '@shared/task-confirmation'
import { TaskActionConfirmation } from './TaskActionConfirmation'

const request: TaskConfirmation = { id: 'batch', title: 'Delete 100 tasks?', confirmLabel: 'Delete 100 tasks', detail: Array.from({ length: 100 }, (_, i) => `Task ${i + 1} [id-${i}]`).join('\n') }
let changed: (next: TaskConfirmation | null) => void
beforeEach(() => {
  window.electronAPI.taskConfirmation = {
    current: vi.fn().mockResolvedValue(request),
    answer: vi.fn(async () => { changed(null) }),
    onChanged: vi.fn(callback => { changed = callback; return vi.fn() })
  }
})
afterEach(cleanup)

it('keeps the full list in a keyboard-scrollable region with separate approval buttons and Cancel focused', async () => {
  render(<TaskActionConfirmation />)
  const confirm = await screen.findByRole('button', { name: 'Delete 100 tasks' })
  const details = screen.getByRole('region', { name: 'Task action details' })
  expect(details.textContent).toBe(request.detail)
  expect(details).toHaveAttribute('tabindex', '0')
  expect(details).not.toContainElement(confirm)
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  fireEvent.click(confirm)
  expect(window.electronAPI.taskConfirmation.answer).toHaveBeenCalledExactlyOnceWith('batch', true)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

it.each(['Cancel', 'Escape'])('declines the current request with %s', async action => {
  render(<TaskActionConfirmation />)
  const cancel = await screen.findByRole('button', { name: 'Cancel' })
  if (action === 'Cancel') fireEvent.click(cancel)
  else fireEvent.keyDown(cancel, { key: 'Escape' })
  expect(window.electronAPI.taskConfirmation.answer).toHaveBeenCalledExactlyOnceWith('batch', false)
})

it('does not reopen a cancelled request when the initial snapshot arrives late', async () => {
  let resolve!: (request: TaskConfirmation) => void
  window.electronAPI.taskConfirmation.current = () => new Promise(done => { resolve = done })
  render(<TaskActionConfirmation />)
  await act(async () => { changed(null); resolve(request) })
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})
