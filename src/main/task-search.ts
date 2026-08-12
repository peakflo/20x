/**
 * Query building for the `/find_similar_tasks` endpoint.
 *
 * Triage quality depends on recall: two people describe the same problem with
 * different words, so an exact-keyword search silently drops relevant history.
 * Two cheap, dependency-free layers widen the net:
 *
 *   1. Stemming — the FTS5 index uses the `porter` tokenizer (see
 *      `database.ts`), so inflected forms collapse to a shared root at both
 *      index and query time: "fixing" / "fixed" / "fix" all match, as do
 *      "issue" / "issues".
 *   2. Synonyms — stemming only relates forms of the *same* word, never words
 *      that merely mean the same thing. The table below bridges those before
 *      the MATCH expression is built, so "bug" also finds "issue" and "error".
 *
 * Everything here is a pure string transform, which keeps it unit-testable
 * without a database.
 */

/**
 * Words that should find each other. Membership is symmetric: listing a word
 * in a group expands every other member of that group to it as well.
 *
 * Two rules keep this list useful rather than noisy:
 *   - No inflections. The Porter stemmer already links "test"/"testing" and
 *     "deploy"/"deployed"; adding them here would only duplicate work.
 *   - Groups stay small (<= 5 words). Every extra synonym is OR-ed into the
 *     query, so an over-broad group makes everything match and the BM25
 *     ranking stops discriminating.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['bug', 'issue', 'error', 'defect', 'failure'],
  ['fix', 'resolve', 'repair', 'patch'],
  ['login', 'signin', 'auth', 'authentication'],
  ['crash', 'hang', 'freeze'],
  ['slow', 'latency', 'performance', 'perf'],
  ['docs', 'documentation', 'readme'],
  ['deploy', 'release', 'rollout'],
  ['remove', 'delete', 'drop'],
  ['add', 'create', 'implement'],
  ['update', 'upgrade', 'bump'],
  ['config', 'configuration', 'settings'],
  ['refactor', 'cleanup', 'tidy'],
  ['api', 'endpoint'],
  ['db', 'database', 'sql']
]

/**
 * Flattens the groups into `word -> [word, ...synonyms]`. A word may appear in
 * more than one group, in which case it expands to the union of both. The word
 * itself always comes first so the caller's original intent leads the query.
 */
function buildSynonymIndex(groups: readonly (readonly string[])[]): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>()

  for (const group of groups) {
    for (const word of group) {
      let terms = index.get(word)
      if (!terms) {
        terms = [word]
        index.set(word, terms)
      }
      for (const synonym of group) {
        if (!terms.includes(synonym)) terms.push(synonym)
      }
    }
  }

  return index
}

const SYNONYM_INDEX = buildSynonymIndex(SYNONYM_GROUPS)

/**
 * Finds the key a word should be looked up under.
 *
 * The table is keyed by singular base forms, and the Porter stemmer only runs
 * later, inside SQLite — so a plural typed by the user ("bugs", "crashes")
 * would miss the table entirely without this step. Trying a couple of cheap
 * singular forms avoids pulling in a JavaScript stemmer for the one place a
 * mismatch can happen.
 */
function synonymKey(word: string): string | null {
  const lower = word.toLowerCase()
  const candidates = [lower, lower.replace(/es$/, ''), lower.replace(/s$/, '')]
  return candidates.find((candidate) => SYNONYM_INDEX.has(candidate)) ?? null
}

/**
 * Expands a single keyword to itself plus its synonyms. Unknown words are
 * returned unchanged, so the caller never has to special-case a miss.
 */
export function expandSynonyms(word: string): readonly string[] {
  const key = synonymKey(word)
  return key ? SYNONYM_INDEX.get(key)! : [word]
}

/**
 * Splits free-text keywords into individual searchable words.
 *
 * Punctuation is stripped because it carries no meaning for the tokenizer, and
 * words of two characters or fewer are dropped — they are almost always noise
 * ("a", "do", "to") and, being prefix-matched, would otherwise pull in most of
 * the table.
 */
function tokenizeKeywords(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .map((word) => word.replace(/[^a-zA-Z0-9_]/g, ''))
    .filter(Boolean)
}

/**
 * Renders one FTS5 term.
 *
 * The value is quoted because a bare `AND`, `OR`, `NOT` or `NEAR` is an
 * operator in the FTS5 grammar and would abort the whole query with a syntax
 * error. Quoting turns it back into an ordinary string to look for. Sanitising
 * first guarantees the value cannot contain a quote of its own.
 */
function ftsTerm(column: string, value: string, prefix: boolean): string {
  return `${column}:"${value}"${prefix ? '*' : ''}`
}

export interface FindSimilarTasksParams {
  title_keywords?: unknown
  description_keywords?: unknown
  type?: unknown
  labels?: unknown
}

export interface SimilarTasksQuery {
  /** Widest expression: stemmed, prefix-matched and synonym-expanded. */
  match: string
  /**
   * The same expression with synonym expansion switched off, or `null` when
   * expansion added nothing. The caller ranks rows matching this above the
   * rest — see the note on buildSimilarTasksQuery.
   */
  exactMatch: string | null
}

/**
 * Collects the MATCH terms for one search.
 *
 * `type` and `labels` are exact filters, so they are neither expanded nor
 * prefixed — they narrow the search rather than widen it.
 */
function collectTerms(params: FindSimilarTasksParams, expand: boolean): Set<string> {
  // A Set collapses the duplicates that synonym expansion inevitably creates,
  // e.g. searching "bug error" expands both words onto the same group.
  const matchTerms = new Set<string>()

  const addKeywords = (column: 'title' | 'description', value: unknown): void => {
    for (const word of tokenizeKeywords(value)) {
      const words = expand ? expandSynonyms(word) : [word]
      for (const candidate of words) {
        matchTerms.add(ftsTerm(column, candidate, true))
      }
    }
  }

  addKeywords('title', params.title_keywords)
  addKeywords('description', params.description_keywords)

  if (typeof params.type === 'string') {
    const cleaned = params.type.replace(/[^a-zA-Z0-9_]/g, '')
    if (cleaned) matchTerms.add(ftsTerm('type', cleaned, false))
  }

  if (Array.isArray(params.labels)) {
    for (const label of params.labels) {
      if (typeof label !== 'string') continue
      const cleaned = label.replace(/[^a-zA-Z0-9_]/g, '')
      if (cleaned) matchTerms.add(ftsTerm('labels', cleaned, false))
    }
  }

  return matchTerms
}

/**
 * Builds the FTS5 expressions for `/find_similar_tasks`.
 *
 * Two are returned because BM25 scores a synonym hit exactly like the word the
 * caller actually typed: relevance then comes down to title length, which can
 * rank "Resolve payment timeout" above a literal "Fix payment" for the query
 * "fix". Left alone, a genuine match can be pushed past the result limit and
 * disappear. The caller therefore sorts `exactMatch` rows into a first tier and
 * ranks by BM25 inside each tier, so widening recall can only ever append
 * results below the literal ones — never displace them.
 *
 * `exactMatch` is `null` when no synonym was added, since the two expressions
 * would be identical and the extra ranking work would be wasted.
 *
 * Returns `null` when nothing searchable was supplied, which tells the caller
 * to fall back to listing recent tasks instead of running an empty query.
 */
export function buildSimilarTasksQuery(params: FindSimilarTasksParams): SimilarTasksQuery | null {
  const expanded = collectTerms(params, true)
  if (expanded.size === 0) return null

  const exact = collectTerms(params, false)

  return {
    match: Array.from(expanded).join(' OR '),
    exactMatch: exact.size === expanded.size ? null : Array.from(exact).join(' OR ')
  }
}
