import { describe, it, expect } from 'vitest'
import { buildSimilarTasksMatchExpression, expandSynonyms } from './task-search'

/**
 * Unit tests for the FTS5 query builder behind /find_similar_tasks.
 *
 * These cover the string shape of the generated expression. The matching
 * behaviour it produces against a real index is covered in
 * find-similar-tasks.test.ts.
 */

/** Splits an expression back into its OR-ed terms for order-free assertions. */
function terms(expression: string | null): string[] {
  return expression ? expression.split(' OR ') : []
}

describe('expandSynonyms', () => {
  it('returns the word itself first, followed by its synonyms', () => {
    const expanded = expandSynonyms('bug')
    expect(expanded[0]).toBe('bug')
    expect(expanded).toContain('issue')
    expect(expanded).toContain('error')
  })

  it('expands symmetrically in both directions', () => {
    expect(expandSynonyms('issue')).toContain('bug')
    expect(expandSynonyms('bug')).toContain('issue')
  })

  it('is case-insensitive', () => {
    expect(expandSynonyms('BUG')).toContain('issue')
  })

  it('falls back to a singular form for plural keywords', () => {
    expect(expandSynonyms('bugs')).toContain('issue')
    expect(expandSynonyms('crashes')).toContain('freeze')
  })

  it('returns an unknown word unchanged', () => {
    expect(expandSynonyms('kubernetes')).toEqual(['kubernetes'])
  })

  it('preserves the original word when no synonym exists', () => {
    // A miss must not drop the term, or the search would return nothing.
    expect(expandSynonyms('invoice')).toEqual(['invoice'])
  })
})

describe('buildSimilarTasksMatchExpression', () => {
  it('returns null when nothing searchable is supplied', () => {
    expect(buildSimilarTasksMatchExpression({})).toBeNull()
    expect(buildSimilarTasksMatchExpression({ title_keywords: '' })).toBeNull()
    expect(buildSimilarTasksMatchExpression({ labels: [] })).toBeNull()
  })

  it('returns null when every keyword is too short to search', () => {
    // Two-character words are dropped, leaving no terms at all.
    expect(buildSimilarTasksMatchExpression({ title_keywords: 'a do it' })).toBeNull()
  })

  it('scopes keywords to their column and prefix-matches them', () => {
    const expression = buildSimilarTasksMatchExpression({ title_keywords: 'payment' })
    expect(terms(expression)).toContain('title:"payment"*')
  })

  it('scopes description keywords to the description column', () => {
    const expression = buildSimilarTasksMatchExpression({ description_keywords: 'stripe' })
    expect(terms(expression)).toEqual(['description:"stripe"*'])
  })

  it('expands each keyword through the synonym table', () => {
    const built = terms(buildSimilarTasksMatchExpression({ title_keywords: 'bug' }))
    expect(built).toContain('title:"bug"*')
    expect(built).toContain('title:"issue"*')
    expect(built).toContain('title:"error"*')
  })

  it('combines terms with OR so any one of them can match', () => {
    const expression = buildSimilarTasksMatchExpression({ title_keywords: 'payment gateway' })
    expect(expression).toBe('title:"payment"* OR title:"gateway"*')
  })

  it('de-duplicates terms that overlap after expansion', () => {
    // "bug" and "error" share a group, so a naive build would repeat terms.
    const built = terms(buildSimilarTasksMatchExpression({ title_keywords: 'bug error' }))
    expect(built.length).toBe(new Set(built).size)
  })

  it('quotes terms so FTS5 operators cannot break the query', () => {
    const built = terms(buildSimilarTasksMatchExpression({ title_keywords: 'AND', type: 'NOT' }))
    expect(built).toContain('title:"AND"*')
    expect(built).toContain('type:"NOT"')
  })

  it('treats type and labels as exact filters, not prefixes', () => {
    const built = terms(buildSimilarTasksMatchExpression({ type: 'coding', labels: ['frontend'] }))
    expect(built).toContain('type:"coding"')
    expect(built).toContain('labels:"frontend"')
    expect(built.every((term) => !term.endsWith('*'))).toBe(true)
  })

  it('does not synonym-expand labels', () => {
    const built = terms(buildSimilarTasksMatchExpression({ labels: ['bug'] }))
    expect(built).toEqual(['labels:"bug"'])
  })

  it('strips punctuation from keywords', () => {
    const built = terms(buildSimilarTasksMatchExpression({ title_keywords: 'user-auth' }))
    expect(built.every((term) => /^title:"[a-zA-Z0-9_]+"\*$/.test(term))).toBe(true)
  })

  it('ignores non-string keyword and label values', () => {
    const expression = buildSimilarTasksMatchExpression({
      title_keywords: 42,
      labels: [null, 'frontend']
    })
    expect(terms(expression)).toEqual(['labels:"frontend"'])
  })
})
