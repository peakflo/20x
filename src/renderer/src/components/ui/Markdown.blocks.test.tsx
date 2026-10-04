/**
 * A long streamed text is rendered as independently memoized blocks. The
 * rendered document must be the same as a single parse of the whole text.
 */
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './Markdown'

const splitToggle = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/lib/markdown-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/markdown-blocks')>()
  return {
    ...actual,
    splitMarkdownBlocks: (source: string) => (splitToggle.enabled ? actual.splitMarkdownBlocks(source) : null)
  }
})

const DOCUMENT = [
  '# Findings',
  '',
  'The agent reviewed the module and found a **race** in the cache path, with `inline code` and a [link](https://example.com).',
  '',
  '- first finding',
  '- second finding with *emphasis*',
  '',
  '```ts',
  'export const a = 1',
  '',
  'export const b = 2',
  '```',
  '',
  '1. step one',
  '',
  '2. step two',
  '',
  '> a quoted remark',
  '',
  '| col | value |',
  '| --- | ----- |',
  '| x   | 1     |',
  '',
  'Closing paragraph. ' + 'Padding sentence to pass the split threshold. '.repeat(60)
].join('\n')

function shape(root: Element): { tags: string[]; text: string } {
  const tags = Array.from(root.querySelectorAll('*')).map((el) => el.tagName)
  // Whitespace-only text nodes between block elements are not visible, so drop all whitespace.
  return { tags, text: (root.textContent ?? '').replace(/\s+/g, '') }
}

describe('Markdown block rendering', () => {
  it('renders a long text the same as a single parse', () => {
    splitToggle.enabled = true
    const split = render(<Markdown size="sm">{DOCUMENT}</Markdown>)
    const splitShape = shape(split.container)
    split.unmount()

    splitToggle.enabled = false
    const whole = render(<Markdown size="sm">{DOCUMENT}</Markdown>)
    const wholeShape = shape(whole.container)
    whole.unmount()
    splitToggle.enabled = true

    expect(splitShape.tags).toEqual(wholeShape.tags)
    expect(splitShape.text).toEqual(wholeShape.text)
  })

  it('keeps ordered-list numbering across a blank line', () => {
    const doc = '1. step one\n\n2. step two\n\n' + 'filler paragraph. '.repeat(200)
    const { container } = render(<Markdown size="sm">{doc}</Markdown>)
    const starts = Array.from(container.querySelectorAll('ol')).map((ol) => ol.getAttribute('start') ?? '1')
    expect(starts).toEqual(['1'])
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })
})
