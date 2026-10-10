/**
 * Resolves once the document's fonts have finished loading, so canvas text
 * (the usage share card's numerals in particular) measures and draws with
 * the real font metrics instead of a fallback face. Falls back to resolving
 * immediately when the Font Loading API isn't available (older environments,
 * and the test environment here, which doesn't implement `document.fonts`).
 */
export function waitForFonts(): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
  if (!fonts?.ready) return Promise.resolve()
  return fonts.ready.then(() => undefined)
}
