/**
 * Markdown block splitting for streamed text — pure logic, no React.
 *
 * An agent answer streams into one growing string. ReactMarkdown re-parses the
 * whole string on every update, so a 20 KB answer costs ~50 ms per streamed
 * delta even though only the last paragraph changed. Splitting the source into
 * top-level blocks lets `Markdown` memoize every finished block and re-parse
 * only the block still being written.
 *
 * A split is taken ONLY where it cannot change how CommonMark renders the text:
 *  - never inside a fenced code block (``` or ~~~, tracked by marker and length);
 *  - only at a blank line that is followed by a non-blank line starting at
 *    column 0 (an indented line may continue the previous block);
 *  - never before a list item (the next list item may belong to the same list,
 *    and a split would restart ordered numbering);
 *  - never when the document has link reference definitions or footnotes,
 *    because those resolve across the whole document;
 *  - never for short texts, which keep the exact single-parse path.
 */

/** Texts shorter than this keep the single-parse path (no behaviour change). */
export const BLOCK_SPLIT_MIN_LENGTH = 2000

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/
const REFERENCE_OR_FOOTNOTE = /^ {0,3}\[[^\]\n]+\]:|\[\^[^\]\n]+\]/m

/**
 * Split `source` into independently parseable top-level blocks.
 * Returns `null` when the text should be rendered as one document.
 */
export function splitMarkdownBlocks(source: string): string[] | null {
  if (source.length < BLOCK_SPLIT_MIN_LENGTH) return null
  if (REFERENCE_OR_FOOTNOTE.test(source)) return null

  const blocks: string[] = []
  let current: string[] = []
  let currentHasContent = false
  let sawBlank = false
  let fence: { char: string; length: number } | null = null

  for (const line of source.split('\n')) {
    if (fence) {
      current.push(line)
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      continue
    }

    if (line.trim() === '') {
      sawBlank = true
      current.push(line)
      continue
    }

    if (sawBlank && currentHasContent && /^\S/.test(line) && !LIST_ITEM.test(line)) {
      blocks.push(current.join('\n'))
      current = []
      currentHasContent = false
    }
    sawBlank = false
    current.push(line)
    currentHasContent = true

    const open = FENCE_OPEN.exec(line)
    if (open) fence = { char: open[1][0], length: open[1].length }
  }

  if (currentHasContent) blocks.push(current.join('\n'))
  return blocks.length > 1 ? blocks : null
}
