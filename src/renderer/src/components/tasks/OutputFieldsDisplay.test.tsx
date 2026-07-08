import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react'
import { OutputFieldsDisplay } from './OutputFieldsDisplay'
import { shellApi } from '@/lib/ipc-client'
import type { OutputField } from '@/types'

// Mock shellApi used by FileFieldPreview
vi.mock('@/lib/ipc-client', () => ({
  shellApi: {
    readTextFile: vi.fn().mockResolvedValue(null),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
  onTaskDeleted: vi.fn(() => vi.fn()),
}))

function makeField(overrides: Partial<OutputField> = {}): OutputField {
  return {
    id: 'field-1',
    name: 'Test Field',
    type: 'text',
    required: false,
    value: undefined,
    ...overrides,
  }
}

describe('OutputFieldsDisplay', () => {
  const onChange = vi.fn()
  const onComplete = vi.fn()

  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    })
  })

  it('shows Complete button when all required fields are filled (optional fields empty)', () => {
    const fields: OutputField[] = [
      makeField({ id: '1', name: 'Required', required: true, value: 'filled' }),
      makeField({ id: '2', name: 'Optional', required: false, value: undefined }),
    ]

    render(
      <OutputFieldsDisplay fields={fields} onChange={onChange} isActive={true} onComplete={onComplete} />
    )

    expect(screen.getByText('Complete Task')).toBeInTheDocument()
  })

  it('hides Complete button when a required field is empty', () => {
    const fields: OutputField[] = [
      makeField({ id: '1', name: 'Required', required: true, value: undefined }),
      makeField({ id: '2', name: 'Optional', required: false, value: 'filled' }),
    ]

    render(
      <OutputFieldsDisplay fields={fields} onChange={onChange} isActive={true} onComplete={onComplete} />
    )

    expect(screen.queryByText('Complete Task')).not.toBeInTheDocument()
  })

  it('shows Complete button when there are no required fields (all optional)', () => {
    const fields: OutputField[] = [
      makeField({ id: '1', name: 'Optional1', required: false, value: undefined }),
      makeField({ id: '2', name: 'Optional2', required: false, value: undefined }),
    ]

    render(
      <OutputFieldsDisplay fields={fields} onChange={onChange} isActive={true} onComplete={onComplete} />
    )

    expect(screen.getByText('Complete Task')).toBeInTheDocument()
  })

  it('shows Complete button when all fields (required and optional) are filled', () => {
    const fields: OutputField[] = [
      makeField({ id: '1', name: 'Required', required: true, value: 'filled' }),
      makeField({ id: '2', name: 'Optional', required: false, value: 'also filled' }),
    ]

    render(
      <OutputFieldsDisplay fields={fields} onChange={onChange} isActive={true} onComplete={onComplete} />
    )

    expect(screen.getByText('Complete Task')).toBeInTheDocument()
  })

  it('hides Complete button when task is not active', () => {
    const fields: OutputField[] = [
      makeField({ id: '1', name: 'Required', required: true, value: 'filled' }),
    ]

    render(
      <OutputFieldsDisplay fields={fields} onChange={onChange} isActive={false} onComplete={onComplete} />
    )

    expect(screen.queryByText('Complete Task')).not.toBeInTheDocument()
  })

  it('hides Complete button when required field has empty string value', () => {
    const fields: OutputField[] = [
      makeField({ id: '1', name: 'Required', required: true, value: '   ' }),
    ]

    render(
      <OutputFieldsDisplay fields={fields} onChange={onChange} isActive={true} onComplete={onComplete} />
    )

    expect(screen.queryByText('Complete Task')).not.toBeInTheDocument()
  })

  it('shows Complete button when required boolean field is false (still counts as filled)', () => {
    const fields: OutputField[] = [
      makeField({ id: '1', name: 'Confirm', type: 'boolean', required: true, value: false }),
    ]

    render(
      <OutputFieldsDisplay fields={fields} onChange={onChange} isActive={true} onComplete={onComplete} />
    )

    expect(screen.getByText('Complete Task')).toBeInTheDocument()
  })

  it('renders malformed legacy output fields without crashing', () => {
    render(
      <OutputFieldsDisplay
        fields={[
          {
            id: 'pr_url',
            type: undefined as never,
            name: undefined as never,
            value: 'https://example.com/pr/123'
          }
        ]}
        onChange={vi.fn()}
      />
    )

    expect(screen.getByDisplayValue('https://example.com/pr/123')).toBeInTheDocument()
    expect(screen.getByText('pr url')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Enter pr url...')).toBeInTheDocument()
  })

  it('copies populated output field values', async () => {
    render(
      <OutputFieldsDisplay
        fields={[makeField({ id: 'summary', name: 'Summary', value: 'Ready for review' })]}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByLabelText('Copy value'))

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Ready for review')
    })
  })

  it('copies text file preview content', async () => {
    vi.mocked(shellApi.readTextFile).mockResolvedValue({ content: 'line 1\nline 2', size: 13 })

    render(
      <OutputFieldsDisplay
        fields={[makeField({ id: 'report', name: 'Report', type: 'file', value: '/tmp/report.md' })]}
        onChange={onChange}
      />
    )

    fireEvent.click(await screen.findByLabelText('Copy file preview'))

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('line 1\nline 2')
    })
  })
})
