import { describe, expect, it } from 'vitest'
import { parseInlineHtmlChoice, validInlineHtmlChoice } from './inline-html-choice'

describe('inline HTML user choices', () => {
  const packet = { type: 'workflo-inline-send', text: 'Yes, solve invoice review',
    options: { action: 'problem.confirm', data: { problemIds: ['invoice-review'] } } }

  it('keeps the exact visible text and small action data', () => {
    expect(parseInlineHtmlChoice(packet)).toEqual({ text: packet.text, ...packet.options })
    expect(validInlineHtmlChoice(packet.text, { sourceMessageId: 'agent-1', ...packet.options })).toBe(true)
  })

  it.each([
    { ...packet, text: '<b>Yes</b>' },
    { ...packet, text: ' Yes' },
    { ...packet, text: 'x'.repeat(2001) },
    { ...packet, options: { action: 'connect;write' } },
    { ...packet, options: { action: 'problem.confirm', data: { raw: 'x'.repeat(5000) } } },
    { ...packet, options: { permission: 'admin' } }
  ])('rejects invalid text or data', (value) => {
    expect(parseInlineHtmlChoice(value)).toBeNull()
  })
})
