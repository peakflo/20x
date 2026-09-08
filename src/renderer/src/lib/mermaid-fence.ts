/**
 * Mermaid fence completeness — pure logic, no React.
 *
 * `Markdown.tsx` streams assistant text token by token (see
 * `AgentTranscriptPanel.tsx`), so at any instant the string handed to
 * `Markdown` may hold an OPEN ```mermaid fence whose closing ``` has not
 * arrived yet. `MermaidDiagram` dispatches purely on the fenced block's
 * language (`getBlockLanguage` in `Markdown.tsx`), with no notion of
 * "still streaming" — so without this guard, every token appended to an
 * in-progress diagram re-triggers `mermaid.render()` against invalid,
 * half-written syntax: a flicker between the raw-source fallback and
 * whatever partial diagram happens to parse, on every streaming tick.
 *
 * CommonMark's own rule is the fix: an UNCLOSED fenced code block runs to the
 * end of the document, so the only fence that can ever be unclosed is the
 * LAST one in the string — every earlier fence is already complete by
 * construction. `markIncompleteMermaidFences` renames a trailing unclosed
 * `mermaid` fence's info string to `mermaid-pending` so `getBlockLanguage`
 * no longer matches `'mermaid'` and the block renders as an ordinary code
 * block until the fence closes. No `streaming` prop has to travel through
 * `AgentTranscriptPanel` → `Markdown` for this to work.
 *
 * Ported from the equivalent helper in workflow-builder
 * (`packages/ui/lib/coding-agents/mermaid-fence.ts`), written for the same
 * mermaid-in-markdown feature there.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/

function closingFenceRe(fenceChar: string, minLen: number): RegExp {
  const escaped = fenceChar === '`' ? '`' : '~'
  return new RegExp(`^ {0,3}${escaped}{${minLen},}[ \\t]*$`)
}

/**
 * Renames the info string of a trailing UNCLOSED ```mermaid fence to
 * `mermaid-pending`. All other text — including earlier, already-closed
 * mermaid fences — is returned unchanged.
 */
export function markIncompleteMermaidFences(source: string): string {
  const lines = source.split('\n')

  let openChar: string | null = null
  let openLen = 0
  let openLineIndex = -1
  let openLang = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (openChar === null) {
      const match = FENCE_OPEN.exec(line)
      if (match) {
        openChar = match[1]?.[0] ?? '`'
        openLen = match[1]?.length ?? 3
        openLineIndex = i
        openLang = match[2] ?? ''
      }
      continue
    }
    if (closingFenceRe(openChar, openLen).test(line)) {
      openChar = null
      openLen = 0
      openLineIndex = -1
      openLang = ''
    }
  }

  const stillOpen = openChar !== null
  const isMermaid = openLang.trim().toLowerCase() === 'mermaid'
  if (!stillOpen || !isMermaid) return source

  const fenceLine = lines[openLineIndex] ?? ''
  lines[openLineIndex] = fenceLine.replace(/mermaid/i, 'mermaid-pending')
  return lines.join('\n')
}
