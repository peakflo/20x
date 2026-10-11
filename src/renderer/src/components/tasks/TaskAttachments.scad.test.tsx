import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskAttachments } from './TaskAttachments'

const { open } = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/lib/ipc-client', () => ({ attachmentApi: { open } }))
vi.mock('@/components/artifacts/viewers/ScadAttachmentEditor', () => ({ ScadAttachmentEditor: () => <div>SCAD editor</div> }))

afterEach(cleanup)

it('opens a SCAD task attachment in the editor', () => {
  render(<TaskAttachments taskId="task-1" items={[{
    id: 'scad-1', filename: 'zero2w_case.scad', size: 100, mime_type: 'application/octet-stream', added_at: '2026-10-11'
  }]} onChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'zero2w_case.scad' }))
  expect(screen.getByRole('dialog', { name: 'Edit zero2w_case.scad' })).toBeTruthy()
  expect(screen.getByText('SCAD editor')).toBeTruthy()
  expect(open).not.toHaveBeenCalled()
})
