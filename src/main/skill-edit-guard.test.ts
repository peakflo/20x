import { describe, expect, it } from 'vitest'
import { guardSkillEdit } from './database'

describe('guardSkillEdit', () => {
  it('holds secrets and email addresses before curator review', () => {
    expect(guardSkillEdit({
      name: 'invoice-check', description: 'Check invoices',
      content: 'Send a note to person@example.com'
    })).toContain('email_address')
    expect(guardSkillEdit({
      name: 'invoice-check', description: 'Check invoices',
      content: '-----BEGIN PRIVATE KEY-----\nabc'
    })).toContain('secret')
  })

  it('allows a general instruction with no private data', () => {
    expect(guardSkillEdit({
      name: 'invoice-check', description: 'Check invoice totals',
      content: 'Compare line totals with the stated total.'
    })).toEqual([])
  })
})
