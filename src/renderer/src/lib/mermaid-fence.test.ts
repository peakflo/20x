import { describe, it, expect } from 'vitest'
import { markIncompleteMermaidFences } from './mermaid-fence'

describe('markIncompleteMermaidFences', () => {
  it('leaves a CLOSED mermaid fence untouched', () => {
    const source = '```mermaid\ngraph TD;\nA-->B;\n```\n'
    expect(markIncompleteMermaidFences(source)).toBe(source)
  })

  it('marks a trailing UNCLOSED mermaid fence as pending (the streaming case)', () => {
    const source = 'Here is a diagram:\n\n```mermaid\ngraph TD;\nA-->'
    const out = markIncompleteMermaidFences(source)
    expect(out).toContain('```mermaid-pending')
    expect(out).not.toMatch(/```mermaid\n/)
    expect(out).toContain('A-->')
  })

  it('does NOT touch an unclosed fence in a different language', () => {
    const source = '```js\nconst x = 1;'
    expect(markIncompleteMermaidFences(source)).toBe(source)
  })

  it('leaves an EARLIER closed mermaid fence alone even while a LATER block streams', () => {
    const source = '```mermaid\ngraph TD;\nA-->B;\n```\n\nAnd now some more tex'
    expect(markIncompleteMermaidFences(source)).toBe(source)
  })

  it('requires the closing fence to use at least as many backticks as the opener', () => {
    const source = '````mermaid\ngraph TD;\n```\nnot closed yet'
    const out = markIncompleteMermaidFences(source)
    expect(out).toContain('````mermaid-pending')
  })

  it('is a no-op for plain prose with no fence at all', () => {
    const source = 'Just some assistant text, streaming in.'
    expect(markIncompleteMermaidFences(source)).toBe(source)
  })
})
