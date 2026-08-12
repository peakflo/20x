import { describe, it, expect } from 'vitest'
import { buildSimilarTasksQuery, expandSynonyms, type FindSimilarTasksParams } from './task-search'

/**
 * Unit tests for the FTS5 query builder behind /find_similar_tasks.
 *
 * These cover the string shape of the generated expressions. The matching and
 * ranking behaviour they produce against a real index is covered in
 * find-similar-tasks.test.ts.
 */

/** Splits an expression back into its OR-ed terms for order-free assertions. */
function terms(expression: string | null): string[] {
  return expression ? expression.split(' OR ') : []
}

/** The widened expression, which is what the search actually runs. */
function matchTerms(params: FindSimilarTasksParams): string[] {
  return terms(buildSimilarTasksQuery(params)?.match ?? null)
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

describe('buildSimilarTasksQuery', () => {
  it('returns null when nothing searchable is supplied', () => {
    expect(buildSimilarTasksQuery({})).toBeNull()
    expect(buildSimilarTasksQuery({ title_keywords: '' })).toBeNull()
    expect(buildSimilarTasksQuery({ labels: [] })).toBeNull()
  })

  it('returns null when every keyword is too short to search', () => {
    // Two-character words are dropped, leaving no terms at all.
    expect(buildSimilarTasksQuery({ title_keywords: 'a do it' })).toBeNull()
  })

  it('scopes keywords to their column and prefix-matches them', () => {
    expect(matchTerms({ title_keywords: 'payment' })).toContain('title:"payment"*')
  })

  it('scopes description keywords to the description column', () => {
    expect(matchTerms({ description_keywords: 'stripe' })).toEqual(['description:"stripe"*'])
  })

  it('expands each keyword through the synonym table', () => {
    const built = matchTerms({ title_keywords: 'bug' })
    expect(built).toContain('title:"bug"*')
    expect(built).toContain('title:"issue"*')
    expect(built).toContain('title:"error"*')
  })

  it('combines terms with OR so any one of them can match', () => {
    expect(buildSimilarTasksQuery({ title_keywords: 'payment gateway' })?.match)
      .toBe('title:"payment"* OR title:"gateway"*')
  })

  it('de-duplicates terms that overlap after expansion', () => {
    // "bug" and "error" share a group, so a naive build would repeat terms.
    const built = matchTerms({ title_keywords: 'bug error' })
    expect(built.length).toBe(new Set(built).size)
  })

  it('quotes terms so FTS5 operators cannot break the query', () => {
    const built = matchTerms({ title_keywords: 'AND', type: 'NOT' })
    expect(built).toContain('title:"AND"*')
    expect(built).toContain('type:"NOT"')
  })

  it('treats type and labels as exact filters, not prefixes', () => {
    const built = matchTerms({ type: 'coding', labels: ['frontend'] })
    expect(built).toContain('type:"coding"')
    expect(built).toContain('labels:"frontend"')
    expect(built.every((term) => !term.endsWith('*'))).toBe(true)
  })

  it('does not synonym-expand labels', () => {
    expect(matchTerms({ labels: ['bug'] })).toEqual(['labels:"bug"'])
  })

  it('strips punctuation from keywords', () => {
    const built = matchTerms({ title_keywords: 'user-auth' })
    expect(built.every((term) => /^title:"[a-zA-Z0-9_]+"\*$/.test(term))).toBe(true)
  })

  it('ignores non-string keyword and label values', () => {
    expect(matchTerms({ title_keywords: 42, labels: [null, 'frontend'] }))
      .toEqual(['labels:"frontend"'])
  })

  describe('exactMatch', () => {
    it('carries the caller wording without synonyms', () => {
      const query = buildSimilarTasksQuery({ title_keywords: 'bug' })
      expect(query?.exactMatch).toBe('title:"bug"*')
      expect(terms(query!.match).length).toBeGreaterThan(1)
    })

    it('is null when expansion added nothing, so no ranking work is wasted', () => {
      expect(buildSimilarTasksQuery({ title_keywords: 'kubernetes' })?.exactMatch).toBeNull()
      expect(buildSimilarTasksQuery({ labels: ['frontend'] })?.exactMatch).toBeNull()
      expect(buildSimilarTasksQuery({ type: 'coding' })?.exactMatch).toBeNull()
    })

    it('keeps exact filters alongside the un-expanded keywords', () => {
      const query = buildSimilarTasksQuery({ title_keywords: 'bug', type: 'coding' })
      expect(terms(query!.exactMatch)).toEqual(['title:"bug"*', 'type:"coding"'])
    })

    it('is always a subset of the widened expression', () => {
      const query = buildSimilarTasksQuery({ title_keywords: 'bug fix', description_keywords: 'login' })
      const widened = terms(query!.match)
      expect(terms(query!.exactMatch).every((term) => widened.includes(term))).toBe(true)
    })
  })
})
