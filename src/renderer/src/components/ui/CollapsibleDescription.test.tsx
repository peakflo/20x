import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
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
})
