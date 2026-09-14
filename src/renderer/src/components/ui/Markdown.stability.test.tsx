import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import mermaid from 'mermaid'
import { Markdown } from './Markdown'

vi.mock('mermaid', () => ({ default: {
  initialize: vi.fn(),
  render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="diagram"><rect /></svg>' })
} }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('keeps rendered content when the link callback changes and uses the current callback', async () => {
  const first = vi.fn().mockReturnValue(true)
  const latest = vi.fn().mockReturnValue(true)
  const text = '[File](data.csv)\n\n```mermaid\ngraph TD\nA --> B\n```\n\nEnd of report'
  const view = render(<Markdown onLinkClick={first}>{text}</Markdown>)
  const diagram = await view.findByTestId('diagram')
  const paragraph = view.getByText('End of report')
  view.rerender(<Markdown onLinkClick={latest}>{text}</Markdown>)
  expect(view.getByTestId('diagram')).toBe(diagram)
  expect(view.getByText('End of report')).toBe(paragraph)
  fireEvent.click(view.getByRole('link', { name: 'File' }))
  expect(latest).toHaveBeenCalledWith('data.csv')
  expect(first).not.toHaveBeenCalled()
  await act(async () => {})
  expect(mermaid.render).toHaveBeenCalledTimes(1)

  view.rerender(<Markdown onLinkClick={latest}>{text.replace('End of report', 'Updated report')}</Markdown>)
  expect(view.getByText('Updated report')).toBe(paragraph)
  expect(view.getByTestId('diagram')).toBe(diagram)

  view.rerender(<Markdown onLinkClick={latest}>{text.replace('A --> B', 'A --> C')}</Markdown>)
  await act(async () => {})
  expect(mermaid.render).toHaveBeenCalledTimes(2)
})
