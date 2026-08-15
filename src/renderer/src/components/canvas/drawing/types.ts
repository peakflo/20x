/**
 * Data model for canvas figures (shapes, typeable text, pasted images).
 *
 * All coordinates are canvas-space — the same space as panel `x/y` — so a
 * figure scales losslessly under the existing CSS transform of the canvas
 * layer (see docs/drawing.md §3–§4).
 */

/** The active drawing tool. `select` is the default (move/select) mode. */
export type DrawingTool =
  | 'select'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'image'

/** Discriminant shared by every figure. */
export type FigureType = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'image'

/**
 * Which diagonal of the bounding box a line/arrow runs along.
 *
 * Endpoints are always box corners; `direction` picks the diagonal so that
 * move/resize/snap stay uniform on the bounding box and the arrowhead renders
 * from the direction (see docs/drawing.md §4).
 */
export type FigureDirection = 'se' | 'sw' | 'ne' | 'nw'

export type TextAlign = 'left' | 'center' | 'right'

/** Common fields for every figure. */
export interface FigureBase {
  id: string
  type: FigureType
  /** Normalized bounding box in canvas space (width/height >= 0). */
  x: number
  y: number
  width: number
  height: number
  /** Stroke color (CSS color). */
  stroke: string
  strokeWidth: number
  /** Fill color, or null for no fill. */
  fill: string | null
  /** 0..1 */
  opacity: number
  /** Z-order within the drawing layer (higher = in front). */
  zIndex: number
}

/**
 * Shape figures. Rectangle/ellipse fill their box; line/arrow run along a box
 * diagonal chosen by `direction`.
 */
export type ShapeFigure =
  | (FigureBase & { type: 'rectangle' | 'ellipse' })
  | (FigureBase & { type: 'line' | 'arrow'; direction: FigureDirection })

/** A typeable text field. */
export interface TextFigure extends FigureBase {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  textAlign: TextAlign
}

/** A pasted image (downscaled data URL, max 1024px on the long edge). */
export interface ImageFigure extends FigureBase {
  type: 'image'
  /** data URL (downscaled on paste, max 1024px on long edge). */
  src: string
}

export type DrawingObject = ShapeFigure | TextFigure | ImageFigure

/**
 * Style applied to newly created figures (and, when a figure is selected,
 * live-updated onto the selection). See docs/drawing.md §5.
 */
export interface DrawingToolOptions {
  stroke: string
  strokeWidth: number
  fill: string | null
  fontSize: number
  fontFamily: string
  fontWeight: number
}

// ── Shared option constants (single source of truth for toolbar + store) ──

/** Stroke width presets (canvas px). */
export const STROKE_WIDTHS = [1, 2, 4, 8] as const

/** Font size presets (canvas px). */
export const FONT_SIZES = [14, 18, 24, 32, 48] as const

/** Font family presets. */
export const FONT_FAMILIES = [
  { id: 'sans', label: 'Sans', css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'serif', label: 'Serif', css: 'ui-serif, Georgia, Cambria, "Times New Roman", serif' },
  { id: 'mono', label: 'Mono', css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
] as const

export type FontFamilyId = (typeof FONT_FAMILIES)[number]['id']

/** Resolve a font family id to its CSS font-family stack. */
export function fontCssFor(id: string): string {
  const match = FONT_FAMILIES.find((f) => f.id === id)
  return match ? match.css : FONT_FAMILIES[0].css
}

/** Stroke color swatches offered in the toolbar. */
export const STROKE_COLORS = [
  '#1e1e1e',
  '#ffffff',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const

/** Fill presets (null = no fill). */
export const FILL_OPTIONS: Array<string | null> = [
  null,
  'rgba(30,30,30,0.12)',
  'rgba(255,255,255,0.12)',
  'rgba(239,68,68,0.18)',
  'rgba(249,115,22,0.18)',
  'rgba(234,179,8,0.18)',
  'rgba(34,197,94,0.18)',
  'rgba(59,130,246,0.18)',
  'rgba(139,92,246,0.18)',
  'rgba(236,72,153,0.18)',
]

/** Default style for new figures. */
export const DEFAULT_TOOL_OPTIONS: DrawingToolOptions = {
  stroke: '#1e1e1e',
  strokeWidth: 2,
  fill: null,
  fontSize: 18,
  fontFamily: 'sans',
  fontWeight: 400,
}

/** Default figure sizes used when a tool is "clicked" (no drag). */
export const DEFAULT_FIGURE_SIZE = {
  rectangle: { width: 160, height: 100 },
  ellipse: { width: 140, height: 140 },
  text: { width: 240, height: 60 },
  image: { width: 240, height: 180 },
} as const

/** Minimum drag size (canvas px) before a created shape is discarded. */
export const MIN_FIGURE_SIZE = 4
