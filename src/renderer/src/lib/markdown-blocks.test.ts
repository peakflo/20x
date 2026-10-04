import { describe, expect, it } from 'vitest'
import { BLOCK_SPLIT_MIN_LENGTH, splitMarkdownBlocks } from './markdown-blocks'

/** Pads text past the minimum length so the split rules (not the threshold) decide. */
function long(text: string): string {
  return text + '\n\n' + 'filler sentence to clear the length threshold. '.repeat(Math.ceil(BLOCK_SPLIT_MIN_LENGTH / 40))
}

describe('splitMarkdownBlocks', () => {
  it('keeps short texts as one document', () => {
    expect(splitMarkdownBlocks('first\n\nsecond')).toBeNull()
  })

  it('splits long prose at blank lines', () => {
    const blocks = splitMarkdownBlocks(long('alpha paragraph\n\nbeta paragraph'))
    expect(blocks).not.toBeNull()
    expect(blocks!.map((b) => b.trim())[0]).toBe('alpha paragraph')
    expect(blocks!.some((b) => b.trim() === 'beta paragraph')).toBe(true)
    expect(blocks!.join('\n')).toContain('beta paragraph')
  })

  it('never splits inside a fenced code block, even with blank lines in it', () => {
    const code = '```ts\nconst a = 1\n\nconst b = 2\n```'
    const blocks = splitMarkdownBlocks(long(`intro\n\n${code}\n\nafter`))
    expect(blocks).not.toBeNull()
    const codeBlock = blocks!.find((b) => b.includes('const a = 1'))
    expect(codeBlock).toContain('const b = 2')
    expect(codeBlock!.trimEnd().endsWith('```')).toBe(true)
  })

  it('treats an unclosed fence as running to the end of the text', () => {
    const blocks = splitMarkdownBlocks(long('before\n\n```\nunterminated\n\nstill code'))
    expect(blocks).not.toBeNull()
    const last = blocks![blocks!.length - 1]
    expect(last).toContain('still code')
  })

  it('does not split before a list item, so ordered numbering and list membership hold', () => {
    const blocks = splitMarkdownBlocks(long('1. first\n\n2. second\n\n3. third'))
    expect(blocks).not.toBeNull()
    const listBlock = blocks!.find((b) => b.includes('1. first'))
    expect(listBlock).toContain('3. third')
  })

  it('does not split when the next line is indented (it may continue the previous block)', () => {
    const blocks = splitMarkdownBlocks(long('- item\n\n  continued paragraph of the item'))
    expect(blocks).not.toBeNull()
    expect(blocks!.some((b) => b.includes('- item') && b.includes('continued paragraph'))).toBe(true)
  })

  it('returns null when reference definitions or footnotes make the document one unit', () => {
    expect(splitMarkdownBlocks(long('see [docs][ref]\n\n[ref]: https://example.com'))).toBeNull()
    expect(splitMarkdownBlocks(long('a claim[^1]\n\n[^1]: a source'))).toBeNull()
  })
})
