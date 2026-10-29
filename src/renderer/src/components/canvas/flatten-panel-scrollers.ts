/** Scroll containers inside canvas panels (transcripts, code blocks, lists). */
const PANEL_SCROLLER_SELECTOR = [
  'overflow-auto',
  'overflow-y-auto',
  'overflow-x-auto',
  'overflow-scroll',
  'overflow-y-scroll',
  'overflow-x-scroll'
]
  .map((cls) => `[data-canvas-panel] .${cls}`)
  .join(', ')

export interface FlattenedScroller {
  el: HTMLElement
  overflow: string
  scrollbarGutter: string
}

/**
 * During a pan/zoom gesture, make panel scroll containers `overflow: hidden`.
 *
 * Chromium gives every user-scrollable overflow container its own composited
 * layer, and every glass bar that overlaps it gets one too (about 5 per task
 * panel, 100+ with 20 panels). A zoom changes the scale of all of them on
 * every frame, so each is re-tiled and re-rastered at the new scale. Measured
 * in the real app with 20 task panels: tile memory sat at its ~650 MB ceiling
 * mid-zoom, cc reported "not enough memory for the tiles needed now" about 160
 * times a second and drew ~4,500 missing tiles a second as holes — transcripts,
 * headers and the grid blinked out (the "flicker"). With the scrollers flattened
 * into the canvas layer the same zoom has 0 such events and ~0 missing tiles.
 *
 * `overflow: hidden` keeps the element a scroll container (scroll offset is
 * kept, no scroll event fires) but it is no longer user-scrollable, so it is
 * painted into the canvas layer instead. Nothing is user-scrollable mid-gesture
 * anyway. Scrollers whose horizontal scrollbar takes layout space are skipped
 * (hiding it would shift layout); a vertical classic scrollbar keeps its space
 * with `scrollbar-gutter: stable`.
 */
export function flattenPanelScrollers(root: HTMLElement): FlattenedScroller[] {
  const candidates: { el: HTMLElement; vbar: boolean }[] = []
  // Reads first (layout is clean at gesture start), then writes.
  for (const el of root.querySelectorAll<HTMLElement>(PANEL_SCROLLER_SELECTOR)) {
    // A container without overflowing content is not composited.
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue
    const cs = window.getComputedStyle(el)
    const vbar =
      el.offsetWidth - el.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0)
    const hbar =
      el.offsetHeight - el.clientHeight - (parseFloat(cs.borderTopWidth) || 0) - (parseFloat(cs.borderBottomWidth) || 0)
    if (hbar > 0.5) continue
    candidates.push({ el, vbar: vbar > 0.5 })
  }
  return candidates.map(({ el, vbar }) => {
    const saved = { el, overflow: el.style.overflow, scrollbarGutter: el.style.scrollbarGutter }
    el.style.overflow = 'hidden'
    if (vbar) el.style.scrollbarGutter = 'stable'
    return saved
  })
}

/** Undo {@link flattenPanelScrollers}. The scroll offset was never lost. */
export function restorePanelScrollers(flattened: FlattenedScroller[]): void {
  for (const { el, overflow, scrollbarGutter } of flattened) {
    el.style.overflow = overflow
    el.style.scrollbarGutter = scrollbarGutter
  }
}
