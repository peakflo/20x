import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { CollapsibleDescription } from './CollapsibleDescription'

// Mock Markdown to render plain text, making it easy to measure
vi.mock('./Markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

const SHORT_DESCRIPTION = 'Short description that fits in one line.'
const LONG_DESCRIPTION = `Line 1 of description
Line 2 of description
Line 3 of description
Line 4 of description
Line 5 of description
Line 6 of description
Line 7 of description
Line 8 of description
Line 9 of description
Line 10 of description`

const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

function mockScrollHeight(height: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return height },
  })
}

function restoreScrollHeight() {
  if (originalScrollHeight) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
  }
}

describe('CollapsibleDescription', () => {
  let localStorageMock: Record<string, string>

  beforeEach(() => {
    localStorageMock = {}
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => localStorageMock[key] ?? null)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      localStorageMock[key] = value
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
      delete localStorageMock[key]
    })
  })

  afterEach(() => {
    cleanup()
    restoreScrollHeight()
    vi.restoreAllMocks()
  })

  it('renders description text', () => {
    const { getByText } = render(
      <CollapsibleDescription taskId="task-1" description={SHORT_DESCRIPTION} />
    )
    expect(getByText(SHORT_DESCRIPTION)).toBeTruthy()
  })

  it('does not show toggle button when content is short', () => {
    const { queryByText } = render(
      <CollapsibleDescription taskId="task-1" description={SHORT_DESCRIPTION} />
    )
    expect(queryByText('Show more')).toBeNull()
    expect(queryByText('Show less')).toBeNull()
  })

  it('shows toggle button when content overflows and toggles state', () => {
    mockScrollHeight(300)

    const { getByText, queryByText } = render(
      <CollapsibleDescription taskId="task-2" description={LONG_DESCRIPTION} />
    )

    // Should show "Show more" button
    expect(getByText('Show more')).toBeTruthy()
    expect(queryByText('Show less')).toBeNull()

    // Click to expand
    fireEvent.click(getByText('Show more'))
    expect(getByText('Show less')).toBeTruthy()
    expect(queryByText('Show more')).toBeNull()

    // Should persist to localStorage
    expect(localStorageMock['20x-desc-expanded-task-2']).toBe('1')

    // Click to collapse
    fireEvent.click(getByText('Show less'))
    expect(getByText('Show more')).toBeTruthy()
    expect(localStorageMock['20x-desc-expanded-task-2']).toBeUndefined()
  })

  it('reads initial expanded state from localStorage', () => {
    localStorageMock['20x-desc-expanded-task-3'] = '1'
    mockScrollHeight(300)

    const { getByText } = render(
      <CollapsibleDescription taskId="task-3" description={LONG_DESCRIPTION} />
    )

    // Should start expanded because localStorage has the flag
    expect(getByText('Show less')).toBeTruthy()
  })

  it('applies maxHeight style when collapsed', () => {
    mockScrollHeight(300)

    const { container, getByText } = render(
      <CollapsibleDescription taskId="task-4" description={LONG_DESCRIPTION} />
    )

    // The content wrapper should have maxHeight set
    const contentDiv = container.querySelector('.overflow-hidden')
    expect(contentDiv).toBeTruthy()
    expect((contentDiv as HTMLElement).style.maxHeight).toBe('100px') // 5 * 20px

    // Expand - maxHeight should be removed
    fireEvent.click(getByText('Show more'))
    expect((contentDiv as HTMLElement).style.maxHeight).toBe('')
  })

  describe('inline editing', () => {
    it('does not render any edit affordance when onSave is not provided', () => {
      render(
        <CollapsibleDescription taskId="task-edit-none" description={SHORT_DESCRIPTION} />
      )
      expect(screen.queryByTestId('description-edit-trigger')).toBeNull()
      expect(screen.queryByTestId('description-add-placeholder')).toBeNull()
    })

    it('renders an "Add description" placeholder when empty and onSave is provided', () => {
      const onSave = vi.fn()
      render(
        <CollapsibleDescription taskId="task-edit-empty" description="" onSave={onSave} />
      )
      const placeholder = screen.getByTestId('description-add-placeholder')
      expect(placeholder).toBeTruthy()
      expect(placeholder.textContent).toMatch(/add description/i)
    })

    it('enters edit mode when the user clicks the description content', () => {
      const onSave = vi.fn()
      render(
        <CollapsibleDescription taskId="task-edit-click" description={SHORT_DESCRIPTION} onSave={onSave} />
      )
      fireEvent.click(screen.getByTestId('description-editable-content'))
      expect(screen.getByTestId('description-edit-textarea')).toBeTruthy()
      expect((screen.getByTestId('description-edit-textarea') as HTMLTextAreaElement).value).toBe(SHORT_DESCRIPTION)
    })

    it('enters edit mode when user clicks the pencil trigger', () => {
      const onSave = vi.fn()
      render(
        <CollapsibleDescription taskId="task-edit-pencil" description={SHORT_DESCRIPTION} onSave={onSave} />
      )
      fireEvent.click(screen.getByTestId('description-edit-trigger'))
      expect(screen.getByTestId('description-edit-textarea')).toBeTruthy()
    })

    it('calls onSave with the new description on save and exits edit mode', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      render(
        <CollapsibleDescription taskId="task-edit-save" description="old" onSave={onSave} />
      )
      fireEvent.click(screen.getByTestId('description-edit-trigger'))
      const textarea = screen.getByTestId('description-edit-textarea') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'new description' } })
      fireEvent.click(screen.getByTestId('description-edit-save'))
      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith('new description')
      })
      await waitFor(() => {
        expect(screen.queryByTestId('description-edit-textarea')).toBeNull()
      })
    })

    it('cancels edit mode and restores original value on Cancel', () => {
      const onSave = vi.fn()
      render(
        <CollapsibleDescription taskId="task-edit-cancel" description="original" onSave={onSave} />
      )
      fireEvent.click(screen.getByTestId('description-edit-trigger'))
      const textarea = screen.getByTestId('description-edit-textarea') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'dirty edit' } })
      fireEvent.click(screen.getByTestId('description-edit-cancel'))
      expect(screen.queryByTestId('description-edit-textarea')).toBeNull()
      expect(onSave).not.toHaveBeenCalled()
      // Re-entering edit should show the original value, not the dirty draft
      fireEvent.click(screen.getByTestId('description-edit-trigger'))
      expect((screen.getByTestId('description-edit-textarea') as HTMLTextAreaElement).value).toBe('original')
    })

    it('escape key cancels editing', () => {
      const onSave = vi.fn()
      render(
        <CollapsibleDescription taskId="task-edit-esc" description="val" onSave={onSave} />
      )
      fireEvent.click(screen.getByTestId('description-edit-trigger'))
      const textarea = screen.getByTestId('description-edit-textarea') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'changed' } })
      fireEvent.keyDown(textarea, { key: 'Escape' })
      expect(screen.queryByTestId('description-edit-textarea')).toBeNull()
      expect(onSave).not.toHaveBeenCalled()
    })

    it('does not call onSave when value is unchanged', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      render(
        <CollapsibleDescription taskId="task-edit-nochange" description="same" onSave={onSave} />
      )
      fireEvent.click(screen.getByTestId('description-edit-trigger'))
      fireEvent.click(screen.getByTestId('description-edit-save'))
      await waitFor(() => {
        expect(screen.queryByTestId('description-edit-textarea')).toBeNull()
      })
      expect(onSave).not.toHaveBeenCalled()
    })

    it('clicking the add-description placeholder opens the edit form', () => {
      const onSave = vi.fn()
      render(
        <CollapsibleDescription taskId="task-edit-placeholder-click" description="" onSave={onSave} />
      )
      fireEvent.click(screen.getByTestId('description-add-placeholder'))
      expect(screen.getByTestId('description-edit-textarea')).toBeTruthy()
    })
  })
})
