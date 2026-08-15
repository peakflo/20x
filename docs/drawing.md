# Canvas Drawing (Figures, Text, Images) — Architecture

**Status:** Approved design — ready for implementation
**Scope:** Add figures (shapes), typeable text fields, and pasted images to the existing InfiniteCanvas. No freehand drawing.
**Platform:** Desktop only — `src/mobile` has no canvas (verified: zero canvas references). No mobile parity needed.

---

## 1. Scope

Per the parent task ("add ability to draw on canvas") and the product clarification:

| In scope (v1) | Out of scope (follow-ups) |
|---|---|
| Shapes: rectangle, ellipse, line, arrow | Freehand pen (if added later: `perfect-freehand` is the smoothing lib of choice) |
| Text fields: typeable, font size + font family | Undo/redo, grouping, alignment, rotation |
| Images: paste from clipboard (Ctrl/Cmd+V + toolbar button) | Export/share, minimap dots, fitToContent inclusion |
| Select / move / resize / delete / duplicate / bring-to-front | Multi-page, collaboration |

Everything lives **inside the canvas screen only** — no global overlays, no separate window.

## 2. Library evaluation & decision

### Excalidraw (`@excalidraw/excalidraw` 0.18.1) — rejected
- It is a complete whiteboard **application**, not a layer: ships its own viewport/pan/zoom, toolbar, selection model, context menu, keyboard shortcuts, and React-context state.
- 20x's InfiniteCanvas already owns all of that. Embedding Excalidraw would duplicate the entire canvas UX and fight the existing viewport, shortcuts (space-pan, Tab-cycle, Ctrl+0), and right-click menu.
- Embedding it as a panel would be a standalone whiteboard card — not "drawing on the canvas".
- Its element model (`ExcalidrawElement[]`) doesn't align with 20x's panel/store model; persistence would need format mapping.
- ~1 MB+ bundle. (React 19 is supported — not the blocker; the architectural mismatch is.)

### Perfect-Freehand (1.2.3) — not needed
- Excellent stroke smoothers (~112 KB, MIT, zero deps; used by Excalidraw/tldraw internally), but it only smooths freehand strokes.
- Freehand is out of scope per the product clarification → no dependency.

### Custom Canvas 2D — rejected
- A pixel canvas would need: a redraw pipeline (re-render on every viewport change via `subscribeLiveViewport` + rAF), DPR handling, manual hit-testing, and an HTML overlay for text editing.
- All of that is unnecessary because the content is **vector shapes + text**, which scale losslessly under the existing CSS transform.

### ✅ Decision: custom SVG + DOM text layer inside the existing CSS-transformed layer. Zero new dependencies.
- The codebase already renders SVG inside the transform layer (`CanvasConnections.tsx`: `absolute inset-0`, `overflow: visible`, `pointer-events-none` root, `pointer-events-auto` interactive children). We follow that established pattern.
- **Crisp at any zoom for free** — vectors scale with the CSS transform; the existing imperative gesture path (direct DOM writes during pan/zoom) needs **zero changes** and no redraw code.
- **Free hit-testing** — DOM pointer events on SVG elements.
- **Native text editing** — `contentEditable` divs, real font rendering, real wrapping.
- **Persistence is trivial** — figures map 1:1 to plain JSON.

## 3. Rendering model

```
InfiniteCanvas (existing)
├── grid (existing, static CSS background)
├── container (existing gesture handlers: wheel pan/zoom, space-pan, context menu)
│   └── transform layer (existing: translate(x,y) scale(zoom), 0×0, overflow visible)
│       ├── SnapGuides (existing)
│       ├── CanvasConnections (existing SVG)
│       ├── DrawingLayer (NEW — figures render above edges, below panels)
│       │   ├── <svg data-drawing-svg> (absolute inset-0, overflow visible, pointer-events-none)
│       │   │   ├── <g data-figure-id> per shape/image figure
│       │   │   │   ├── <rect> / <ellipse> / <line> / <path> (arrow) / <image>
│       │   │   │   └── invisible fat-stroke hit path for thin lines/arrows
│       │   │   ├── creation preview (liveObject while dragging a new figure)
│       │   │   └── selection overlay: dashed outline + resize handles (pointer-events-auto)
│       │   └── text figures: absolutely-positioned <div>s (contentEditable while editing)
│       └── panels (existing CanvasPanel × N)
├── DrawingToolbar (NEW — floating, bottom-center; canvas screen only)
├── DrawingProperties (NEW — floating, shown when a figure is selected)
├── HUD zoom controls / Add button / minimap / context menu (existing)
```

- **Z-order:** figures above connection lines, below panels — annotations sit behind task cards. Figures under a panel can't be selected in v1 (acceptable).
- **Screen→canvas conversion** uses the existing `getLiveViewport()`: `(clientX - rect.left - vp.x) / vp.zoom` — same formula as `InfiniteCanvas.handleContextMenu`.
- **Gestures:** creating/moving/resizing figures follows the `CanvasPanel` imperative pattern — direct DOM writes inside rAF during the gesture, single store commit on mouseup. Pan/zoom/wheel/space-pan are untouched.

## 4. Data model

`src/renderer/src/components/canvas/drawing/types.ts`

```ts
export type DrawingTool = 'select' | 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'image'

interface FigureBase {
  id: string
  type: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'image'
  /** Normalized bounding box in canvas space (w/h >= 0) */
  x: number
  y: number
  width: number
  height: number
  stroke: string
  strokeWidth: number
  fill: string | null
  opacity: number
  zIndex: number
}

/** line/arrow: endpoints are box corners; direction selects which diagonal */
type ShapeFigure = FigureBase & {
  type: 'rectangle' | 'ellipse'
} | (FigureBase & { type: 'line' | 'arrow'; direction: 'se' | 'sw' | 'ne' | 'nw' })

interface TextFigure extends FigureBase {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  textAlign: 'left' | 'center' | 'right'
}

interface ImageFigure extends FigureBase {
  type: 'image'
  /** data URL (downscaled on paste, max 1024px on long edge) */
  src: string
}

export type DrawingObject = ShapeFigure | TextFigure | ImageFigure
```

- All coordinates are canvas-space (same space as panel `x/y`).
- `direction` keeps line/arrow move/resize/snap uniform on the bounding box; arrowheads render from the direction.
- Images are data URLs; downscale on paste keeps the persisted blob small.

## 5. State model — `drawing-store.ts` (Zustand slice)

New file `src/renderer/src/stores/drawing-store.ts`, mirroring `canvas-store.ts` conventions (subscribeWithSelector, ID counters, structural-equality bailouts on hot setters, debounced persistence).

```ts
interface DrawingToolOptions {
  stroke: string
  strokeWidth: number
  fill: string | null
  fontSize: number
  fontFamily: string
  fontWeight: number
}

interface DrawingState {
  // ── persisted ──
  objects: DrawingObject[]
  nextZIndex: number
  isLoaded: boolean

  // ── transient: active tool + style ──
  activeTool: DrawingTool
  toolOptions: DrawingToolOptions

  // ── transient: interaction ──
  selectedIds: string[]
  editingTextId: string | null      // text figure currently in contentEditable mode
  liveObject: DrawingObject | null  // figure being created (drag preview)

  // ── actions ──
  loadDrawings: () => Promise<void>
  setTool: (tool: DrawingTool) => void
  setToolOption: <K extends keyof DrawingToolOptions>(key: K, value: DrawingToolOptions[K]) => void
  addObject: (obj: Omit<DrawingObject, 'id' | 'zIndex'>) => string
  updateObject: (id: string, updates: Partial<Omit<DrawingObject, 'id' | 'type'>>) => void
  removeObjects: (ids: string[]) => void
  bringToFront: (id: string) => void
  duplicateObject: (id: string) => void
  select: (ids: string[]) => void
  clearSelection: () => void
  setEditingTextId: (id: string | null) => void
  setLiveObject: (obj: DrawingObject | null) => void
  clearAll: () => void
}
```

- **Persistence:** `drawing_state` key in the same SQLite settings table, 1000 ms debounce — identical `scheduleSave` pattern to `canvas-store`. Loaded in parallel with `loadCanvas()` in `InfiniteCanvas`'s mount effect.
- **Transient state** (activeTool, toolOptions, selection, editing, liveObject) is never persisted.
- `setLiveObject` bails out on structural equality (same pattern as `setSnapGuides`/`setProximityEdge`).
- `addObject` assigns `figure-${++counter}-${Date.now()}` IDs; `loadDrawings` restores the counter from persisted IDs (same as panels/edges).

## 6. Component tree & new files

```
src/renderer/src/stores/drawing-store.ts
src/renderer/src/components/canvas/drawing/
  types.ts               — DrawingObject / DrawingTool model
  figure-geometry.ts     — pure helpers: normalizeBox, figureDirection, arrowPath, hitTest
  DrawingLayer.tsx       — SVG layer + text divs + create/move/resize/selection interactions
  FigureShape.tsx        — memoized per-figure SVG rendering (rect/ellipse/line/arrow/image)
  FigureText.tsx         — memoized text figure div (contentEditable while editing)
  DrawingToolbar.tsx     — tool buttons + style controls (color, stroke width, fill, font size, font family)
  DrawingProperties.tsx  — selected-figure actions (delete, duplicate, bring to front, text font controls)
```

### DrawingLayer responsibilities
1. **Create:** when `activeTool !== 'select'`, a full-area transparent rect (`pointer-events-auto`) captures mousedown on empty canvas → drag creates `liveObject` (rAF, imperative) → mouseup commits via `addObject` (min-size guard: < 4 px = discard for shapes, click = default-size text/image).
2. **Select:** select tool — click figure → `select([id])`; shift+click multi-select; click empty canvas → `clearSelection()`.
3. **Move:** drag selected figure — imperative transform, single `updateObject` commit on mouseup (CanvasPanel pattern).
4. **Resize:** bottom-right handle (v1) — imperative, single commit.
5. **Text edit:** double-click text figure → `setEditingTextId(id)` → `contentEditable` div focused with text selected → commit on blur/Escape via `updateObject`.
6. **Render:** `objects.map` → `FigureShape`/`FigureText` (memoized), plus creation preview and selection overlay.

### DrawingToolbar
Floating bar (bottom-center, canvas screen only, same HUD styling as zoom controls):
- Tools: Select (V), Rectangle (R), Ellipse (O), Line (L), Arrow (A), Text (T), Image (I)
- Style: stroke color swatches, stroke width (1/2/4/8), fill toggle (none/solid), font size (14/18/24/32/48), font family (sans/serif/mono)
- Style controls apply to `toolOptions` (affect new figures) and to the current selection (live `updateObject`).

### DrawingProperties
Shown when `selectedIds.length > 0`: delete, duplicate, bring-to-front, and (for text) font size/family/weight controls.

## 7. Integration points with InfiniteCanvas

1. **Transform layer** — `DrawingLayer` is a child of the existing transform layer (after `CanvasConnections`, before panels). Pan/zoom/pinch work with zero drawing code — the CSS transform scales everything.
2. **Pointer coordination** —
   - With a drawing tool active, `InfiniteCanvas.handleMouseDown` must NOT start panning on background mousedown: one guard reading `useDrawingStore.getState().activeTool` (imperative read, no subscription — same pattern as the existing `connectingFromId` check).
   - Space+drag, middle-button pan, wheel pan/zoom always take precedence (unchanged).
   - **Escape** cancels `liveObject` / exits text editing — added to the existing Escape handler.
   - **Delete/Backspace** removes selected figures — added to the existing keydown handler with the same `isInputFocused` guard (and suppressed while `editingTextId` is set).
   - **Ctrl/Cmd+V** on the canvas (not while editing text) pastes an image.
3. **Keyboard shortcuts** — V/R/O/L/A/T/I tool switching in the existing keydown handler, guarded by `isInputFocused` like the other shortcuts.
4. **Context menu** — `CanvasContextMenu` gains a "Draw" section (Rectangle, Ellipse, Line, Arrow, Text, Image) that sets `activeTool` and closes the menu.
5. **Persistence** — `drawing_state` key, same debounced settings table; `loadDrawings()` called alongside `loadCanvas()`.
6. **Minimap / fitToContent** — v1: unchanged. Follow-up: include figure bounds in `fitToContent` and render figure dots on the minimap.
7. **Mobile** — desktop only (canvas does not exist in `src/mobile`).

## 8. Performance

- **Zero work during pan/zoom** — compositor scales the SVG/DOM layer; no redraws, no DPR handling, no store writes (existing invariant preserved).
- Memoized figure components (like `CanvasPanel`) so one figure's change doesn't re-render others.
- DOM node count = figure count (tens–hundreds) — trivial for SVG/DOM.
- Creation/move/resize gestures: one style write per rAF frame, one store commit at the end.

## 9. Testing (vitest + happy-dom, same setup as `InfiniteCanvas.test.tsx`)

- `drawing-store.test.ts` — add/update/remove/duplicate/bringToFront, selection, persistence round-trip, `setLiveObject` bail-out, ID counter restore on load.
- `figure-geometry.test.ts` — box normalization, line/arrow direction + path, hit-testing per type.
- `DrawingLayer.test.tsx` — drag creates a rectangle; click with text tool creates a text figure; double-click → edit → commit on blur; Escape cancels creation.

## 10. Risks / follow-ups

- **Image blob size** — downscale to max 1024 px on paste (offscreen canvas → data URL); cap total persisted size, evict oldest images if the settings blob grows past ~5 MB.
- **Text metrics** — v1 uses fixed box with resize handle; auto-fit height is a follow-up.
- **Figures under panels** — unselectable while covered; acceptable in v1.
- **Pen tool** — if requested later, add `perfect-freehand` (1.2.3) + a `pen` figure type with raw points; the store/rendering architecture already accommodates it.
