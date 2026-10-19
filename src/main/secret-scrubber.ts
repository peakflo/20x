/**
 * SecretScrubber — redacts known secret values out of agent output before it
 * is stored, rendered, or broadcast anywhere.
 *
 * Built per session from every value that session's agent process could have
 * seen or produced: the agent's configured secrets, OAuth/MCP bearer tokens
 * injected for that session, and provider API keys present in the app's own
 * environment. A value is replaced with `«$VAR_NAME»` when its source name is
 * known, or `«secret»` when it isn't.
 *
 * Beyond the literal value, each entry also matches a handful of transformed
 * forms a model or a shell pipeline commonly produces: base64, base64url,
 * URL-encoded, and JSON-escaped. `Bearer <value>` needs no special case —
 * the literal-value pattern already matches the value substring inside it,
 * so the "Bearer " prefix is left intact and only the token is redacted.
 *
 * Scrub at *assembled* text (a fully buffered message part, a complete log
 * line, a persisted DB field) — never per streaming delta — so a value split
 * across two chunks is never missed.
 */

const MIN_SECRET_LENGTH = 6

export interface SecretEntry {
  /** Display name used in the replacement token, e.g. "OPENAI_API_KEY". Omit for an unnamed/opaque token. */
  name?: string
  value: string | undefined | null
}

interface CompiledPattern {
  // The literal string this pattern matches (one variant of one secret's value).
  literal: string
  replacement: string
}

/**
 * A value is too short, or low-entropy enough (all-digit, all one repeated
 * character, empty/whitespace) that treating it as a secret risks redacting
 * ordinary numbers or placeholders instead of catching real leaks.
 */
export function isTrivialSecretValue(value: string): boolean {
  if (!value) return true
  if (value.length < MIN_SECRET_LENGTH) return true
  if (/^\s*$/.test(value)) return true
  if (/^\d+$/.test(value)) return true
  if (new Set(value).size <= 1) return true
  return false
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function jsonEscapedInner(value: string): string {
  // JSON.stringify("abc") -> `"abc"`; strip the surrounding quotes to get just
  // the escaped body, which is what shows up when the value is embedded in a
  // JSON string that itself got logged/stored as text.
  const json = JSON.stringify(value)
  return json.slice(1, -1)
}

/** All textual forms of `value` worth matching literally. De-duplicated. */
function variantsOf(value: string): string[] {
  const variants = new Set<string>()
  variants.add(value)
  try { variants.add(Buffer.from(value, 'utf8').toString('base64')) } catch { /* ignore */ }
  try { variants.add(base64url(value)) } catch { /* ignore */ }
  try { variants.add(encodeURIComponent(value)) } catch { /* ignore */ }
  try { variants.add(jsonEscapedInner(value)) } catch { /* ignore */ }
  return [...variants].filter((v) => v.length >= MIN_SECRET_LENGTH)
}

export class SecretScrubber {
  private patterns: CompiledPattern[] = []
  private combined: RegExp | null = null
  private seenLiterals = new Set<string>()

  constructor(entries: SecretEntry[] = []) {
    this.addEntries(entries)
  }

  get isEmpty(): boolean {
    return this.patterns.length === 0
  }

  /** Number of distinct secret values currently tracked (for tests/logging — never logs values). */
  get entryCount(): number {
    return this.seenLiterals.size
  }

  addEntries(entries: SecretEntry[]): void {
    let changed = false
    for (const entry of entries) {
      if (!entry.value) continue
      const value = entry.value
      if (isTrivialSecretValue(value)) continue
      if (this.seenLiterals.has(value)) continue
      this.seenLiterals.add(value)

      const replacement = entry.name ? `«$${entry.name}»` : '«secret»'
      for (const literal of variantsOf(value)) {
        this.patterns.push({ literal, replacement })
        changed = true
      }
    }
    if (changed) this.recompile()
  }

  private recompile(): void {
    if (this.patterns.length === 0) {
      this.combined = null
      return
    }
    // Longest-literal-first so a longer value's pattern is tried before a
    // shorter one that happens to be a substring of it.
    const sorted = [...this.patterns].sort((a, b) => b.literal.length - a.literal.length)
    const alternation = sorted.map((p) => escapeRegExp(p.literal)).join('|')
    this.combined = new RegExp(alternation, 'g')
    this.replacementByLiteral = new Map(sorted.map((p) => [p.literal, p.replacement]))
  }

  private replacementByLiteral: Map<string, string> = new Map()

  /** Scrub a fully-assembled string. Safe (and cheap) to call on text with no secrets at all. */
  scrub(text: string | undefined | null): string | undefined | null {
    if (text === undefined || text === null) return text
    if (!this.combined || text.length === 0) return text
    return text.replace(this.combined, (match) => this.replacementByLiteral.get(match) ?? '«secret»')
  }

  /**
   * Deep-scrub an arbitrary JSON-ish value (tool input/output objects,
   * question/plan payloads, attachment metadata). Strings are scrubbed in
   * place; other primitives pass through unchanged. Returns a new value,
   * the original is never mutated.
   */
  scrubDeep<T>(value: T): T {
    if (this.isEmpty) return value
    return this.scrubDeepInner(value) as T
  }

  private scrubDeepInner(value: unknown): unknown {
    if (typeof value === 'string') return this.scrub(value)
    if (Array.isArray(value)) return value.map((v) => this.scrubDeepInner(v))
    if (value && typeof value === 'object') {
      // Minor finding, re-review: this used to treat ANY object (`value &&
      // typeof value === 'object'`) as a plain record to decompose via
      // `Object.entries` and rebuild as `{}` — which corrupts a `Date`
      // (no own enumerable properties, so it silently became `{}`), a
      // `Buffer`/typed array (its numeric byte indices got enumerated and
      // rebuilt as `{0: ..., 1: ..., ...}`, destroying the binary value),
      // or any other class instance with real behavior/private state.
      // Only recurse into values that are ACTUALLY plain objects — anything
      // else passes through unchanged, exactly as scrubDeep's own docstring
      // already promised ("other primitives pass through unchanged").
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return value
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.scrubDeepInner(v)
      }
      return out
    }
    return value
  }
}

/** A scrubber that never matches anything — used when a session has no known secrets. */
export const NOOP_SCRUBBER = new SecretScrubber([])
