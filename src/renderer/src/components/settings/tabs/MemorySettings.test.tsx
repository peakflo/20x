import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import type { MastermindMemory } from '@/types'

const list = vi.fn()
const create = vi.fn()
const update = vi.fn()
const del = vi.fn()
const clearAll = vi.fn()
const exportToFile = vi.fn()
const importFromFile = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  memoryApi: {
    list: (...args: unknown[]) => list(...args),
    get: vi.fn(),
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
    delete: (...args: unknown[]) => del(...args),
    clearAll: (...args: unknown[]) => clearAll(...args),
    exportToFile: (...args: unknown[]) => exportToFile(...args),
    importFromFile: (...args: unknown[]) => importFromFile(...args)
  },
  onMastermindMemorySaved: () => () => undefined,
  onMastermindMemoryDeleted: () => () => undefined,
  settingsApi: {
    get: vi.fn(async () => null as string | null),
    set: vi.fn(async () => undefined)
  }
}))

import { MemorySettings } from './MemorySettings'

function makeMemory(overrides: Partial<MastermindMemory> = {}): MastermindMemory {
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
  cleanup()
  vi.clearAllMocks()
  list.mockResolvedValue([])
})

describe('MemorySettings', () => {
  it('shows an empty state when there is nothing remembered yet', async () => {
    render(<MemorySettings />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(await screen.findByText("Mastermind doesn't remember anything yet")).toBeInTheDocument()
  })

  it('lists memories with their kind, scope and pinned badge', async () => {
    list.mockResolvedValue([
      makeMemory({ id: 'mem-1', content: 'Always use pnpm.', pinned: true }),
      makeMemory({ id: 'mem-2', content: 'Deploys happen on Fridays.', kind: 'procedure', scope: 'project:abc', pinned: false })
    ])
    render(<MemorySettings />)

    expect(await screen.findByText('Always use pnpm.')).toBeInTheDocument()
    expect(screen.getByText('Deploys happen on Fridays.')).toBeInTheDocument()
    expect(screen.getByText('pinned')).toBeInTheDocument()
    // "project:abc" appears both as the scope badge and as a scope-filter
    // <option>; just confirm the badge rendered among the matches.
    expect(screen.getAllByText('project:abc').length).toBeGreaterThan(0)
  })

  it('filters the visible list by search text', async () => {
    list.mockResolvedValue([
      makeMemory({ id: 'mem-1', content: 'Always use pnpm.' }),
      makeMemory({ id: 'mem-2', content: 'Deploys happen on Fridays.' })
    ])
    render(<MemorySettings />)
    await screen.findByText('Always use pnpm.')

    const search = screen.getByPlaceholderText('Search memories...')
    fireEvent.change(search, { target: { value: 'pnpm' } })

    expect(screen.getByText('Always use pnpm.')).toBeInTheDocument()
    expect(screen.queryByText('Deploys happen on Fridays.')).not.toBeInTheDocument()
  })

  it('toggles pin via the pin button', async () => {
    list.mockResolvedValue([makeMemory({ id: 'mem-1', pinned: false })])
    update.mockResolvedValue(makeMemory({ id: 'mem-1', pinned: true }))
    render(<MemorySettings />)
    await screen.findByText('Always use pnpm.')

    fireEvent.click(screen.getByTitle('Pin'))

    await waitFor(() => expect(update).toHaveBeenCalledWith('mem-1', { pinned: true }))
  })

  it('deletes a memory after confirmation', async () => {
    list.mockResolvedValue([makeMemory({ id: 'mem-1' })])
    del.mockResolvedValue(true)
    window.confirm = vi.fn(() => true)
    const confirmSpy = window.confirm as ReturnType<typeof vi.fn>
    render(<MemorySettings />)
    await screen.findByText('Always use pnpm.')

    fireEvent.click(screen.getByTitle('Forget'))

    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() => expect(del).toHaveBeenCalledWith('mem-1'))
  })

  it('does not delete when the user cancels the confirmation', async () => {
    list.mockResolvedValue([makeMemory({ id: 'mem-1' })])
    window.confirm = vi.fn(() => false)
    render(<MemorySettings />)
    await screen.findByText('Always use pnpm.')

    fireEvent.click(screen.getByTitle('Forget'))

    expect(del).not.toHaveBeenCalled()
  })

  it('clears all memories after confirmation', async () => {
    list.mockResolvedValue([makeMemory({ id: 'mem-1' })])
    clearAll.mockResolvedValue(1)
    window.confirm = vi.fn(() => true)
    render(<MemorySettings />)
    await screen.findByText('Always use pnpm.')

    fireEvent.click(screen.getByText('Clear all'))

    await waitFor(() => expect(clearAll).toHaveBeenCalled())
  })

  it('exports memories to a file', async () => {
    list.mockResolvedValue([makeMemory({ id: 'mem-1' })])
    exportToFile.mockResolvedValue({ saved: true, filePath: '/tmp/mastermind-memories.json' })
    render(<MemorySettings />)
    await screen.findByText('Always use pnpm.')

    fireEvent.click(screen.getByText('Export'))

    await waitFor(() => expect(exportToFile).toHaveBeenCalled())
  })

  it('imports memories from a file and shows the result', async () => {
    list.mockResolvedValue([])
    importFromFile.mockResolvedValue({ imported: 2, skipped: 1 })
    render(<MemorySettings />)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByText('Import'))

    expect(await screen.findByText('Imported 2, skipped 1.')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('filters by kind using the kind dropdown', async () => {
    list.mockResolvedValue([
      makeMemory({ id: 'mem-1', content: 'A preference note', kind: 'preference' }),
      makeMemory({ id: 'mem-2', content: 'A procedure note', kind: 'procedure' })
    ])
    render(<MemorySettings />)
    await screen.findByText('A preference note')

    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'procedure' } })

    expect(screen.queryByText('A preference note')).not.toBeInTheDocument()
    expect(screen.getByText('A procedure note')).toBeInTheDocument()
  })

  it('opens the add-memory dialog and creates a memory', async () => {
    list.mockResolvedValue([])
    create.mockResolvedValue(makeMemory({ id: 'mem-new', content: 'New preference' }))
    render(<MemorySettings />)
    await waitFor(() => expect(list).toHaveBeenCalled())

    fireEvent.click(screen.getByText('Add Your First Memory'))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Content'), { target: { value: 'New preference' } })
    await act(async () => {
      fireEvent.click(within(dialog).getByText('Create'))
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ content: 'New preference', kind: 'preference' }))
  })
})
