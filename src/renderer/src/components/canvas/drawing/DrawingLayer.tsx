import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useDrawingStore, type NewFigure } from '@/stores/drawing-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useThemeStore } from '@/stores/theme-store'
import { getLiveViewport } from '@/stores/canvas-live-viewport'
import {
  DEFAULT_FIGURE_SIZE,
  DEFAULT_STROKE,
  MIN_FIGURE_SIZE,
  type DrawingObject,
  type DrawingTool,
  type DrawingToolOptions,
  type FigureDirection,
} from './types'
import {
  arrowPath,
  figureDirection,
  lineEndpoints,
  normalizeBox,
  unionBox,
  type Box,
} from './figure-geometry'
import { FigureShape } from './FigureShape'
import { FigureText } from './FigureText'
import { downscaleImageToDataUrl, readClipboardImage } from './image-paste'

/**
 * How far (px, screen space) the pointer must move after a mousedown on a
 * text figure being edited before the gesture is treated as a drag (which
 * commits the text and moves the figure) rather than a caret click.
 */
const EDIT_DRAG_THRESHOLD = 3

/**
 * The drawing layer — figures (shapes, text, images) rendered inside the
 * existing CSS-transformed canvas layer (docs/drawing.md §3).
 *
 * Follows the CanvasConnections pattern: a 0×0 absolute root with overflow
 * visible, an SVG that is pointer-events-none at the root with
 * pointer-events-auto interactive children. Pan/zoom scale everything for
 * free — zero redraws, no DPR handling.
 *
 * Gestures (create/move/resize) follow the CanvasPanel imperative pattern:
 * direct DOM writes inside rAF during the gesture, a single store commit on
 * mouseup.
 */
export function DrawingLayer() {
  const objects = useDrawingStore((s) => s.objects)
  const selectedIds = useDrawingStore((s) => s.selectedIds)
  const liveObject = useDrawingStore((s) => s.liveObject)
  const activeTool = useDrawingStore((s) => s.activeTool)
  const editingTextId = useDrawingStore((s) => s.editingTextId)
  const zoom = useCanvasStore((s) => s.viewport.zoom)

  const rootRef = useRef<HTMLDivElement>(null)
  const captureRectRef = useRef<HTMLDivElement>(null)
  const selectionGroupRef = useRef<SVGGElement>(null)

  // Space+drag pans the canvas even while a tool is active (InfiniteCanvas
  // owns the pan gesture) — track Space so the capture surface lets those
  // mousedowns bubble through instead of starting a creation gesture.
  const spaceHeldRef = useRef(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) spaceHeldRef.current = true
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false
    }
    const blur = () => {
      spaceHeldRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // ── Commit text editing when the user clicks outside the edited figure ──
  // Figures are non-focusable divs (and the canvas preventDefaults its
  // mousedowns), so the browser never blurs the contentEditable on its own —
  // clicking another figure, the background, a panel or the minimap would
  // otherwise leave the text in editing mode. A capture-phase window listener
  // commits the edit (blur → onBlur → onCommitText) before the canvas' own
  // mousedown handlers run. Clicks inside the edited figure (caret placement)
  // and focus on non-figure elements (terminals, inputs) are left alone.
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const editingId = useDrawingStore.getState().editingTextId
      if (!editingId) return
      const target = e.target as HTMLElement | null
      if (target?.closest?.(`[data-figure-id="${editingId}"]`)) return
      const el = document.activeElement
      if (el instanceof HTMLElement && el.closest?.('[data-figure-id]')) el.blur()
    }
    window.addEventListener('mousedown', handleMouseDown, true)
    return () => window.removeEventListener('mousedown', handleMouseDown, true)
  }, [])

  const selectMode = activeTool === 'select'

  /** Screen → canvas-space conversion via the layer's own (transformed) rect. */
  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const root = rootRef.current
    if (!root) return { x: 0, y: 0 }
    const rect = root.getBoundingClientRect()
    const vp = getLiveViewport()
    return {
      x: (clientX - rect.left) / vp.zoom,
      y: (clientY - rect.top) / vp.zoom,
    }
  }, [])

  // ── Create gesture ────────────────────────────────────────
  const startCreation = useCallback(
    (e: React.MouseEvent) => {
      const { activeTool, toolOptions, setLiveObject, addObject, setTool, setEditingTextId } =
        useDrawingStore.getState()
      const start = toCanvasPoint(e.clientX, e.clientY)

      // Defensive: the capture rect is only hit-testable in tool mode.
      if (activeTool === 'select') return

      if (activeTool === 'text') {
        // Drag = text figure at the drag box (like the shape tools); a plain
        // click = default-size figure at the click point. Either way the new
        // figure opens in editing mode on mouseup.
        const size = DEFAULT_FIGURE_SIZE.text
        let cancelled = false
        let hasPublished = false
        let rafId: number | null = null
        let lastEvent: MouseEvent | null = null
        let finalBox: Box | null = null

        const unsub = useDrawingStore.subscribe((s) => s.liveObject, (lo) => {
          if (lo === null && hasPublished) cancelled = true
        })

        const publish = () => {
          rafId = null
          const ev = lastEvent
          if (!ev || cancelled) return
          const cur = toCanvasPoint(ev.clientX, ev.clientY)
          const box = normalizeBox(start.x, start.y, cur.x, cur.y)
          if (box.width < MIN_FIGURE_SIZE && box.height < MIN_FIGURE_SIZE) return
          finalBox = box
          hasPublished = true
          setLiveObject({
            type: 'text',
            ...box,
            stroke: strokeForNewFigure(toolOptions),
            strokeWidth: toolOptions.strokeWidth,
            fill: null,
            opacity: 1,
            text: '',
            fontSize: toolOptions.fontSize,
            fontFamily: toolOptions.fontFamily,
            fontWeight: toolOptions.fontWeight,
            textAlign: 'left',
            id: 'live-preview',
            zIndex: 0,
          })
        }

        const handleMove = (ev: MouseEvent) => {
          lastEvent = ev
          if (rafId == null) rafId = requestAnimationFrame(publish)
        }

        const handleUp = () => {
          window.removeEventListener('mousemove', handleMove)
          window.removeEventListener('mouseup', handleUp)
          unsub()
          if (rafId != null) {
            cancelAnimationFrame(rafId)
            rafId = null
          }
          if (cancelled) {
            setLiveObject(null)
            return
          }
          if (lastEvent) publish()
          setLiveObject(null)
          const box =
            finalBox ??
            ({
              x: start.x - size.width / 2,
              y: start.y - size.height / 2,
              width: size.width,
              height: size.height,
            } as Box)
          const id = addObject({
            type: 'text',
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            stroke: strokeForNewFigure(toolOptions),
            strokeWidth: toolOptions.strokeWidth,
            fill: null,
            opacity: 1,
            text: '',
            fontSize: toolOptions.fontSize,
            fontFamily: toolOptions.fontFamily,
            fontWeight: toolOptions.fontWeight,
            textAlign: 'left',
          })
          setTool('select')
          setEditingTextId(id)
        }

        window.addEventListener('mousemove', handleMove)
        window.addEventListener('mouseup', handleUp)
        return
      }

      if (activeTool === 'image') {
        void pasteImageAt(start.x, start.y)
        return
      }

      // Shape drag creation: rAF preview via liveObject, single addObject on
      // mouseup. Escape (or a tool switch) clears liveObject — that cancels.
      let cancelled = false
      let hasPublished = false
      let rafId: number | null = null
      let lastEvent: MouseEvent | null = null
      let finalBox: Box | null = null
      let finalDir: FigureDirection | null = null

      const unsub = useDrawingStore.subscribe((s) => s.liveObject, (lo) => {
        if (lo === null && hasPublished) cancelled = true
      })

      const publish = () => {
        rafId = null
        const ev = lastEvent
        if (!ev || cancelled) return
        const cur = toCanvasPoint(ev.clientX, ev.clientY)
        finalBox = normalizeBox(start.x, start.y, cur.x, cur.y)
        finalDir = figureDirection(start.x, start.y, cur.x, cur.y)
        hasPublished = true
        setLiveObject({ ...buildFigure(activeTool, finalBox, finalDir, toolOptions), id: 'live-preview', zIndex: 0 })
      }

      const handleMove = (ev: MouseEvent) => {
        lastEvent = ev
        if (rafId == null) rafId = requestAnimationFrame(publish)
      }

      const handleUp = () => {
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleUp)
        unsub()
        if (rafId != null) {
          cancelAnimationFrame(rafId)
          rafId = null
        }
        if (cancelled) {
          setLiveObject(null)
          return
        }
        if (lastEvent) publish()
        setLiveObject(null)
        const box = finalBox
        const dir = finalDir
        if (!box || !dir) return
        // A click without a real drag is discarded for shapes (text/image use
        // default sizes instead).
        if (box.width < MIN_FIGURE_SIZE && box.height < MIN_FIGURE_SIZE) return
        addObject(buildFigure(activeTool, box, dir, toolOptions))
      }

      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleUp)
    },
    [toCanvasPoint]
  )

  // ── Move gesture (select tool) ────────────────────────────
  const startSelectMove = useCallback((e: React.MouseEvent, hitId: string) => {
    const store = useDrawingStore.getState()
    const { selectedIds } = store

    // Clicking a text figure that is *already* selected (no drag) re-enters
    // editing — discoverable without knowing the double-click gesture.
    const reClickEditsText =
      !e.shiftKey &&
      selectedIds.includes(hitId) &&
      store.objects.find((o) => o.id === hitId)?.type === 'text'

    let nextSelected: string[]
    if (e.shiftKey) {
      nextSelected = selectedIds.includes(hitId) ? selectedIds : [...selectedIds, hitId]
      store.select(nextSelected)
    } else if (!selectedIds.includes(hitId)) {
      nextSelected = [hitId]
      store.select(nextSelected)
    } else {
      nextSelected = selectedIds
    }

    const root = rootRef.current
    if (!root) return
    const items = nextSelected
      .map((id) => {
        const obj = useDrawingStore.getState().objects.find((o) => o.id === id)
        const node = root.querySelector(`[data-figure-id="${id}"]`)
        return obj && node ? { id, obj, node } : null
      })
      .filter((item): item is { id: string; obj: DrawingObject; node: Element } => item !== null)
    if (items.length === 0) return

    let rafId: number | null = null
    let lastEvent: MouseEvent | null = null
    let dx = 0
    let dy = 0
    const overlay = selectionGroupRef.current

    const apply = () => {
      rafId = null
      const ev = lastEvent
      if (!ev) return
      const vp = getLiveViewport()
      dx = (ev.clientX - e.clientX) / vp.zoom
      dy = (ev.clientY - e.clientY) / vp.zoom
      for (const item of items) {
        if (item.node instanceof HTMLElement) {
          item.node.style.transform = `translate(${dx}px, ${dy}px)`
        } else {
          item.node.setAttribute('transform', `translate(${dx}, ${dy})`)
        }
      }
      if (overlay) overlay.setAttribute('transform', `translate(${dx}, ${dy})`)
    }

    const handleMove = (ev: MouseEvent) => {
      lastEvent = ev
      if (rafId == null) rafId = requestAnimationFrame(apply)
    }

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      if (rafId != null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      if (lastEvent) apply()
      // Single store commit for the whole move.
      if (dx !== 0 || dy !== 0) {
        const { updateObject } = useDrawingStore.getState()
        for (const item of items) {
          updateObject(item.id, { x: item.obj.x + dx, y: item.obj.y + dy })
        }
      }
      // A plain re-click (no drag) on a selected text figure opens it for editing.
      if (dx === 0 && dy === 0 && reClickEditsText) {
        useDrawingStore.getState().setEditingTextId(hitId)
      }
      for (const item of items) {
        if (item.node instanceof HTMLElement) item.node.style.transform = ''
        else item.node.removeAttribute('transform')
      }
      if (overlay) overlay.removeAttribute('transform')
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [])

  // ── Drag start on a figure being edited ───────────────────
  // A text figure in editing mode must still be movable: plain clicks place
  // the caret (no preventDefault), but a drag past a small threshold commits
  // the text (blur) and turns into a regular move gesture.
  const startEditDrag = useCallback(
    (e: React.MouseEvent, hitId: string) => {
      const startX = e.clientX
      const startY = e.clientY
      let started = false

      const handleMove = (ev: MouseEvent) => {
        if (started) return
        if (
          Math.abs(ev.clientX - startX) < EDIT_DRAG_THRESHOLD &&
          Math.abs(ev.clientY - startY) < EDIT_DRAG_THRESHOLD
        )
          return
        started = true
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleUp)
        // Commit the in-progress text so the figure behaves like a normal
        // figure during the drag (blur triggers the commit + ends editing).
        const el = document.activeElement
        if (el instanceof HTMLElement) el.blur()
        startSelectMove(e, hitId)
      }

      const handleUp = () => {
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleUp)
      }

      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleUp)
    },
    [startSelectMove]
  )

  // ── Resize gesture (single selection, bottom-right handle) ──
  const startResize = useCallback(() => {
    const { selectedIds, objects } = useDrawingStore.getState()
    if (selectedIds.length !== 1) return
    const id = selectedIds[0]
    const obj = objects.find((o) => o.id === id)
    const root = rootRef.current
    const node = root?.querySelector(`[data-figure-id="${id}"]`)
    if (!obj || !node) return

    const origin = { x: obj.x, y: obj.y }
    let rafId: number | null = null
    let lastEvent: MouseEvent | null = null
    let finalBox: Box = { x: obj.x, y: obj.y, width: obj.width, height: obj.height }
    const overlay = selectionGroupRef.current
    const outline = overlay?.querySelector('[data-figure-outline="true"]') as SVGRectElement | null
    const handle = overlay?.querySelector('[data-figure-resize="true"]') as SVGRectElement | null
    const handleSize = handle ? parseFloat(handle.getAttribute('width') ?? '10') : 10

    const apply = () => {
      rafId = null
      const ev = lastEvent
      if (!ev) return
      const cur = toCanvasPoint(ev.clientX, ev.clientY)
      const box = normalizeBox(origin.x, origin.y, cur.x, cur.y)
      box.width = Math.max(MIN_FIGURE_SIZE, box.width)
      box.height = Math.max(MIN_FIGURE_SIZE, box.height)
      finalBox = box
      applyBoxToDom(node, obj, box)
      if (outline) {
        outline.setAttribute('x', String(box.x))
        outline.setAttribute('y', String(box.y))
        outline.setAttribute('width', String(box.width))
        outline.setAttribute('height', String(box.height))
      }
      if (handle) {
        handle.setAttribute('x', String(box.x + box.width - handleSize / 2))
        handle.setAttribute('y', String(box.y + box.height - handleSize / 2))
      }
    }

    const handleMove = (ev: MouseEvent) => {
      lastEvent = ev
      if (rafId == null) rafId = requestAnimationFrame(apply)
    }

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      if (rafId != null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      if (lastEvent) apply()
      if (finalBox.width !== obj.width || finalBox.height !== obj.height) {
        useDrawingStore.getState().updateObject(id, finalBox)
      }
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [toCanvasPoint])

  // ── Event delegation ──────────────────────────────────────
  const handleLayerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as Element

      // Creation: the full-area capture rect (only hit-testable in tool mode).
      if (target === captureRectRef.current) {
        // Space+drag is a pan gesture — let it reach the canvas container.
        if (spaceHeldRef.current) return
        e.preventDefault()
        e.stopPropagation()
        startCreation(e)
        return
      }

      // Resize handle (select mode, single selection).
      if (target.closest?.('[data-figure-resize="true"]')) {
        e.preventDefault()
        e.stopPropagation()
        startResize()
        return
      }

      // Figure hit (select mode).
      const figureEl = target.closest?.('[data-figure-id]')
      if (figureEl) {
        const id = figureEl.getAttribute('data-figure-id') ?? ''
        // A text figure being edited: plain clicks place the caret, drags
        // commit the text and move the figure.
        if (useDrawingStore.getState().editingTextId === id) {
          startEditDrag(e, id)
          return
        }
        e.preventDefault()
        e.stopPropagation()
        startSelectMove(e, id)
        return
      }
    },
    [startCreation, startResize, startSelectMove, startEditDrag]
  )

  const handleLayerDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as Element
    const figureEl = target.closest?.('[data-figure-id]')
    if (!figureEl) return
    const id = figureEl.getAttribute('data-figure-id')
    if (!id) return
    const { objects, setEditingTextId } = useDrawingStore.getState()
    const obj = objects.find((o) => o.id === id)
    if (obj?.type === 'text') {
      e.stopPropagation()
      setEditingTextId(id)
    }
  }, [])

  const handleCommitText = useCallback((id: string, text: string) => {
    const { updateObject, removeObjects, setEditingTextId } = useDrawingStore.getState()
    if (text.trim() === '') {
      // An empty text figure is invisible and useless — remove it instead of
      // leaving a ghost box on the canvas.
      removeObjects([id])
    } else {
      updateObject(id, { text })
    }
    setEditingTextId(null)
  }, [])

  // ── Render ────────────────────────────────────────────────
  const sortedObjects = useMemo(
    () => [...objects].sort((a, b) => a.zIndex - b.zIndex),
    [objects]
  )

  const selectionBox = useMemo(() => {
    if (selectedIds.length === 0) return null
    const selected = objects.filter((o) => selectedIds.includes(o.id))
    return selected.length > 0 ? unionBox(selected) : null
  }, [objects, selectedIds])

  const handleSize = 10 / zoom
  const outlineStroke = 1.5 / zoom

  return (
    <div
      ref={rootRef}
      data-drawing-layer="true"
      className="absolute inset-0"
      style={{ overflow: 'visible', pointerEvents: 'none' }}
      onMouseDown={handleLayerMouseDown}
      onDoubleClick={handleLayerDoubleClick}
    >
      <svg className="absolute inset-0" style={{ overflow: 'visible', pointerEvents: 'none' }}>
        {/* Shape/image figures, z-sorted */}
        {sortedObjects.map((obj) =>
          obj.type === 'text' ? null : <FigureShape key={obj.id} obj={obj} />
        )}

        {/* Selection overlay: dashed outline + bottom-right resize handle */}
        {selectMode && selectionBox && (
          <g ref={selectionGroupRef}>
            <rect
              data-figure-outline="true"
              x={selectionBox.x}
              y={selectionBox.y}
              width={selectionBox.width}
              height={selectionBox.height}
              fill="none"
              stroke="rgba(30,150,235,0.9)"
              strokeWidth={outlineStroke}
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
            />
            {selectedIds.length === 1 && (
              <rect
                data-figure-resize="true"
                x={selectionBox.x + selectionBox.width - handleSize / 2}
                y={selectionBox.y + selectionBox.height - handleSize / 2}
                width={handleSize}
                height={handleSize}
                fill="var(--canvas-panel, #1e1e1e)"
                stroke="rgba(30,150,235,0.9)"
                strokeWidth={outlineStroke}
                className="pointer-events-auto cursor-nwse-resize"
              />
            )}
          </g>
        )}

        {/* Creation preview (liveObject while dragging a new figure). Text
            previews render as a dashed rect — FigureShape has no text body. */}
        {liveObject &&
          (liveObject.type === 'text' ? (
            <rect
              x={liveObject.x}
              y={liveObject.y}
              width={liveObject.width}
              height={liveObject.height}
              fill="none"
              stroke="rgba(30,150,235,0.9)"
              strokeWidth={outlineStroke}
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
            />
          ) : (
            <FigureShape obj={liveObject} />
          ))}
      </svg>

      {/* Full-area capture surface — a real HTML element (reliable browser
          hit-testing, unlike SVG content in a 0×0 overflow-visible svg),
          topmost of the layer, mounted only in tool mode. pointer-events must
          be set explicitly: the layer root is pointer-events:none and the
          property is inherited — without this the div is invisible to the
          browser's hit-testing and no creation gesture ever starts. */}
      {!selectMode && (
        <div
          ref={captureRectRef}
          data-drawing-capture="true"
          className="absolute"
          style={{
            left: -100_000,
            top: -100_000,
            width: 200_000,
            height: 200_000,
            cursor: 'crosshair',
            pointerEvents: 'auto',
          }}
        />
      )}

      {/* Text figures — DOM divs above the SVG (contentEditable while editing) */}
      {sortedObjects.map((obj) =>
        obj.type === 'text' ? (
          <FigureText
            key={obj.id}
            obj={obj}
            isEditing={editingTextId === obj.id}
            interactive={selectMode}
            onCommitText={handleCommitText}
          />
        ) : null
      )}
    </div>
  )
}

// ── Paste (Ctrl/Cmd+V in InfiniteCanvas, or a click with the image tool) ──

/**
 * Paste the clipboard image as a figure centered on canvas point (x, y).
 * Returns the new figure id, or null when the clipboard holds no image.
 */
export async function pasteImageAt(x: number, y: number): Promise<string | null> {
  const file = await readClipboardImage()
  if (!file) return null
  const img = await downscaleImageToDataUrl(file)
  if (!img) return null
  const { addObject } = useDrawingStore.getState()
  return addObject({
    type: 'image',
    x: x - img.width / 2,
    y: y - img.height / 2,
    width: img.width,
    height: img.height,
    stroke: DEFAULT_STROKE[useThemeStore.getState().resolved],
    strokeWidth: 2,
    fill: null,
    opacity: 1,
    src: img.src,
  })
}

// ── Pure helpers ────────────────────────────────────────────

/**
 * Stroke for new figures: while the user hasn't explicitly picked a color,
 * follow the current theme (the factory defaults are theme-specific — dark
 * text is invisible on the dark canvas).
 */
function strokeForNewFigure(options: DrawingToolOptions): string {
  const { stroke } = options
  if (stroke !== DEFAULT_STROKE.light && stroke !== DEFAULT_STROKE.dark) return stroke
  return DEFAULT_STROKE[useThemeStore.getState().resolved]
}

/** Build a figure (minus id/zIndex) from a tool, a box and the tool options. */
function buildFigure(
  tool: Exclude<DrawingTool, 'select' | 'text' | 'image'>,
  box: Box,
  dir: FigureDirection,
  options: DrawingToolOptions
): NewFigure {
  const base = {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    stroke: strokeForNewFigure(options),
    strokeWidth: options.strokeWidth,
    fill: tool === 'rectangle' || tool === 'ellipse' ? options.fill : null,
    opacity: 1,
  }
  if (tool === 'line' || tool === 'arrow') {
    return { type: tool, direction: dir, ...base }
  }
  return { type: tool, ...base }
}

/**
 * Imperatively resize one figure's DOM to `box` during a resize gesture
 * (no React render — the store is committed once on mouseup).
 */
function applyBoxToDom(node: Element, obj: DrawingObject, box: Box) {
  switch (obj.type) {
    case 'rectangle': {
      const rect = node.querySelector('rect')
      if (rect) {
        rect.setAttribute('x', String(box.x))
        rect.setAttribute('y', String(box.y))
        rect.setAttribute('width', String(box.width))
        rect.setAttribute('height', String(box.height))
      }
      return
    }
    case 'ellipse': {
      const el = node.querySelector('ellipse')
      if (el) {
        el.setAttribute('cx', String(box.x + box.width / 2))
        el.setAttribute('cy', String(box.y + box.height / 2))
        el.setAttribute('rx', String(box.width / 2))
        el.setAttribute('ry', String(box.height / 2))
      }
      return
    }
    case 'line': {
      const { from, to } = lineEndpoints(box, obj.direction)
      for (const line of node.querySelectorAll('line')) {
        line.setAttribute('x1', String(from.x))
        line.setAttribute('y1', String(from.y))
        line.setAttribute('x2', String(to.x))
        line.setAttribute('y2', String(to.y))
      }
      return
    }
    case 'arrow': {
      const { from, to } = lineEndpoints(box, obj.direction)
      const geo = arrowPath(from, to, obj.strokeWidth)
      node.querySelector('path')?.setAttribute('d', geo.shaftD)
      node.querySelector('polygon')?.setAttribute('points', geo.headPoints)
      for (const line of node.querySelectorAll('line')) {
        line.setAttribute('x1', String(from.x))
        line.setAttribute('y1', String(from.y))
        line.setAttribute('x2', String(to.x))
        line.setAttribute('y2', String(to.y))
      }
      return
    }
    case 'image': {
      const img = node.querySelector('image')
      if (img) {
        img.setAttribute('x', String(box.x))
        img.setAttribute('y', String(box.y))
        img.setAttribute('width', String(box.width))
        img.setAttribute('height', String(box.height))
      }
      return
    }
    case 'text': {
      const div = node as HTMLElement
      div.style.width = `${box.width}px`
      div.style.height = `${box.height}px`
      return
    }
  }
}
