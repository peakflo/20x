import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { MastermindMemoryRecord } from '@shared/mastermind-memory'

const list = vi.fn()
const del = vi.fn()

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      memories: {
        list: (...args: unknown[]) => list(...args),
        delete: (...args: unknown[]) => del(...args)
      }
    }
  }
})

import { MemorySection } from './MemorySection'

function makeMemory(overrides: Partial<MastermindMemoryRecord> = {}): MastermindMemoryRecord {
  return {
    id: 'mem-1',
    scope: 'global',
    kind: 'preference',
    content: 'Always use pnpm.',
    source: 'user-stated',
    importance: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    expires_at: null,
    pinned: false,
    ...overrides
  }
}

beforeEach(() => {
  list.mockReset()
  del.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('MemorySection (mobile, read-only + delete)', () => {
  it('lists memories with kind/scope/pinned', async () => {
    list.mockResolvedValue([makeMemory({ pinned: true })])
    render(<MemorySection />)

    expect(await screen.findByText('Always use pnpm.')).toBeTruthy()
    expect(screen.getByText('preference')).toBeTruthy()
    expect(screen.getByText('pinned')).toBeTruthy()
  })

  it('shows a friendly empty state', async () => {
    list.mockResolvedValue([])
    render(<MemorySection />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(screen.getByText('Nothing remembered yet.')).toBeTruthy()
  })

  it('deletes a memory and removes it from the list — no add/edit affordance', async () => {
    list.mockResolvedValue([makeMemory({ id: 'mem-1' })])
    del.mockResolvedValue({ success: true, id: 'mem-1' })
    render(<MemorySection />)
    await screen.findByText('Always use pnpm.')

    // Read-only on mobile: there is no edit control, only delete.
    expect(screen.queryByText('Edit')).toBeNull()

    fireEvent.click(screen.getByLabelText('Forget this memory'))

    await waitFor(() => expect(del).toHaveBeenCalledWith('mem-1'))
    expect(screen.queryByText('Always use pnpm.')).toBeNull()
  })

  it('shows an error without crashing when the delete fails', async () => {
    list.mockResolvedValue([makeMemory({ id: 'mem-1' })])
    del.mockRejectedValue(new Error('network down'))
    render(<MemorySection />)
    await screen.findByText('Always use pnpm.')

    fireEvent.click(screen.getByLabelText('Forget this memory'))

    expect(await screen.findByText('network down')).toBeTruthy()
    // The item stays, since the delete did not actually succeed.
    expect(screen.getByText('Always use pnpm.')).toBeTruthy()
  })
})
