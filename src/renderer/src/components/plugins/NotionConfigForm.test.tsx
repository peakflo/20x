import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { NotionConfigForm } from './NotionConfigForm'

afterEach(cleanup)

const mockResolveOptions = vi.fn()
vi.mock('@/lib/ipc-client', () => ({
  pluginApi: {
    resolveOptions: (...args: unknown[]) => mockResolveOptions(...args)
  },
  onTaskDeleted: vi.fn(() => vi.fn())
}))

const STATUS_PROPERTY = {
  name: 'Status',
  type: 'status',
  options: [
    { value: 'Icebox', label: 'Icebox' },
    { value: 'Ready for QA', label: 'Ready for QA' },
    { value: 'Shipped', label: 'Shipped' }
  ]
}

const CONNECTED = { api_token: 'ntn_test', data_source_id: 'db-1' }

beforeEach(() => {
  mockResolveOptions.mockReset()
  // data_sources resolves first, then data_source_properties.
  mockResolveOptions.mockImplementation((_plugin: string, resolverKey: string) => {
    if (resolverKey === 'data_sources') {
      return Promise.resolve([{ value: 'db-1', label: 'Tasks DB' }])
    }
    return Promise.resolve([{ value: JSON.stringify(STATUS_PROPERTY), label: 'Status' }])
  })
})

describe('NotionConfigForm — next statuses', () => {
  it('lists the status options of the selected data source', async () => {
    render(<NotionConfigForm value={CONNECTED} onChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('notion-next-statuses')).toBeDefined()
    })
    expect(screen.getByLabelText('Ready for QA')).toBeDefined()
    expect(screen.getByLabelText('Shipped')).toBeDefined()
  })

  it('stores the statuses the user selects', async () => {
    const onChange = vi.fn()
    render(<NotionConfigForm value={CONNECTED} onChange={onChange} />)

    await waitFor(() => expect(screen.getByLabelText('Shipped')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Shipped'))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ next_statuses: ['Shipped'] })
    )
  })

  it('offers a completion status once statuses are selected', async () => {
    render(
      <NotionConfigForm
        value={{ ...CONNECTED, next_statuses: ['Ready for QA', 'Shipped'] }}
        onChange={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByTestId('notion-completion-status')).toBeDefined())
    const select = screen.getByTestId('notion-completion-status') as HTMLSelectElement
    // "Detect automatically" plus the two selected statuses.
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'Ready for QA',
      'Shipped'
    ])
  })

  it('hides the completion status until a next status is selected', async () => {
    render(<NotionConfigForm value={CONNECTED} onChange={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('notion-next-statuses')).toBeDefined())
    expect(screen.queryByTestId('notion-completion-status')).toBeNull()
  })

  it('clears a completion status the user removes from the list', async () => {
    const onChange = vi.fn()
    render(
      <NotionConfigForm
        value={{ ...CONNECTED, next_statuses: ['Shipped'], completion_status: 'Shipped' }}
        onChange={onChange}
      />
    )

    await waitFor(() => expect(screen.getByLabelText('Shipped')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Shipped'))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ next_statuses: [], completion_status: '' })
    )
  })
})
