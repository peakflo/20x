import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { DrawingLayer, pasteImageAt } from './DrawingLayer'
import { readClipboardImage, downscaleImageToDataUrl } from './image-paste'
import { useDrawingStore } from '@/stores/drawing-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useThemeStore } from '@/stores/theme-store'
import type { DrawingObject } from './types'

vi.mock('./image-paste', () => ({
  readClipboardImage: vi.fn(),
  downscaleImageToDataUrl: vi.fn(),
  MAX_IMAGE_EDGE: 1024,
}))

const flushFrames = async () => {
  // rAF + the queued microtasks React uses to commit
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const makeRect = (over: {
  id?: string
  x?: number
  y?: number
  width?: number
  height?: number
} = {}): DrawingObject => ({
  id: 'figure-1-1',
  type: 'rectangle',
  x: 100,
  y: 100,
  width: 100,
  height: 60,
  stroke: '#1e1e1e',
  strokeWidth: 2,
  fill: null,
  opacity: 1,
  zIndex: 1,
  ...over,
})

const toNewFigure = (fig: DrawingObject) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, zIndex: _z, ...rest } = fig
  return rest
}

describe('DrawingLayer', () => {
  beforeEach(() => {
    vi.mocked(readClipboardImage).mockReset()
    vi.mocked(downscaleImageToDataUrl).mockReset()

    useDrawingStore.setState({
      objects: [],
      nextZIndex: 1,
      isLoaded: true,
      activeTool: 'select',
      toolOptions: {
        stroke: '#1e1e1e',
        strokeWidth: 2,
        fill: null,
        fontSize: 18,
        fontFamily: 'sans',
        fontWeight: 400,
      },
      selectedIds: [],
      editingTextId: null,
      liveObject: null,
    })
    useCanvasStore.setState({ viewport: { x: 0, y: 0, zoom: 1 } })
    // Light theme by default so the factory stroke (#1e1e1e) is the expected
    // one; individual tests switch to dark where relevant.
    useThemeStore.getState().setMode('light')
  })

  afterEach(cleanup)

  it('renders nothing when there are no figures', () => {
    const { container } = render(<DrawingLayer />)
    expect(container.querySelector('[data-figure-id]')).toBeNull()
  })

  it('renders text figures as DOM divs with the figure text', () => {
    useDrawingStore.getState().addObject({
      type: 'text',
      x: 10,
      y: 10,
      width: 200,
      height: 60,
      stroke: '#1e1e1e',
      strokeWidth: 2,
      fill: null,
      opacity: 1,
      text: 'Hello World',
      fontSize: 18,
      fontFamily: 'sans',
      fontWeight: 400,
      textAlign: 'left',
    })
    render(<DrawingLayer />)
    expect(screen.getByText('Hello World')).toBeTruthy()
  })

  it('renders the selection outline for selected figures', () => {
    const id = useDrawingStore.getState().addObject(toNewFigure(makeRect()))
    useDrawingStore.getState().select([id])
    const { container } = render(<DrawingLayer />)
    expect(container.querySelector('[data-figure-outline="true"]')).toBeTruthy()
    expect(container.querySelector('[data-figure-resize="true"]')).toBeTruthy()
  })

  // ── Creation ──────────────────────────────────────────────

  it('drag with the rectangle tool creates a rectangle figure', async () => {
    useDrawingStore.getState().setTool('rectangle')
    const { container } = render(<DrawingLayer />)
    const capture = container.querySelector('[data-drawing-capture="true"]') as Element
    expect(capture).toBeTruthy()

    fireEvent.mouseDown(capture, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 200, clientY: 160 })
    await flushFrames()

    // Live preview while dragging
    expect(useDrawingStore.getState().liveObject).toMatchObject({
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 100,
      height: 60,
    })

    fireEvent.mouseUp(window)
    const { objects, liveObject } = useDrawingStore.getState()
    expect(liveObject).toBeNull()
    expect(objects).toHaveLength(1)
    expect(objects[0]).toMatchObject({
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 100,
      height: 60,
      stroke: '#1e1e1e',
      strokeWidth: 2,
    })
    // The committed figure renders in the SVG
    expect(container.querySelector(`[data-figure-id="${objects[0].id}"]`)).toBeTruthy()
  })

  it('arrow tool records the drag direction', async () => {
    useDrawingStore.getState().setTool('arrow')
    const { container } = render(<DrawingLayer />)
    const capture = container.querySelector('[data-drawing-capture="true"]') as Element

    fireEvent.mouseDown(capture, { button: 0, clientX: 200, clientY: 200 })
    fireEvent.mouseMove(window, { clientX: 100, clientY: 100 })
    await flushFrames()
    fireEvent.mouseUp(window)

    expect(useDrawingStore.getState().objects[0]).toMatchObject({
      type: 'arrow',
      direction: 'nw',
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    })
  })

  it('discards sub-minimum drags', async () => {
    useDrawingStore.getState().setTool('rectangle')
    const { container } = render(<DrawingLayer />)
    const capture = container.querySelector('[data-drawing-capture="true"]') as Element

    fireEvent.mouseDown(capture, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 101, clientY: 101 })
    await flushFrames()
    fireEvent.mouseUp(window)

    expect(useDrawingStore.getState().objects).toHaveLength(0)
  })

  it('click with the text tool creates a default-size text figure and enters editing', () => {
    useDrawingStore.getState().setTool('text')
    render(<DrawingLayer />)
    const capture = document.querySelector('[data-drawing-capture="true"]') as Element

    fireEvent.mouseDown(capture, { button: 0, clientX: 150, clientY: 120 })
    fireEvent.mouseUp(window)

    const { objects, editingTextId, activeTool } = useDrawingStore.getState()
    expect(objects).toHaveLength(1)
    expect(objects[0]).toMatchObject({
      type: 'text',
      x: 30,
      y: 90,
      width: 240,
      height: 60,
      text: '',
    })
    expect(editingTextId).toBe(objects[0].id)
    // The tool drops back to select so typing goes into the new figure.
    expect(activeTool).toBe('select')
  })

  it('drag with the text tool creates a text figure at the drag box', async () => {
    useDrawingStore.getState().setTool('text')
    const { container } = render(<DrawingLayer />)
    const capture = container.querySelector('[data-drawing-capture="true"]') as Element

    fireEvent.mouseDown(capture, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 200, clientY: 160 })
    await flushFrames()

    // Live preview while dragging
    expect(useDrawingStore.getState().liveObject).toMatchObject({
      type: 'text',
      x: 100,
      y: 100,
      width: 100,
      height: 60,
    })

    fireEvent.mouseUp(window)
    const { objects, liveObject, editingTextId } = useDrawingStore.getState()
    expect(liveObject).toBeNull()
    expect(objects).toHaveLength(1)
    expect(objects[0]).toMatchObject({
      type: 'text',
      x: 100,
      y: 100,
      width: 100,
      height: 60,
      text: '',
    })
    expect(editingTextId).toBe(objects[0].id)
  })

  it('defaults new figures to a stroke visible on the dark theme', async () => {
    useThemeStore.getState().setMode('dark')
    useDrawingStore.getState().setTool('rectangle')
    const { container } = render(<DrawingLayer />)
    const capture = container.querySelector('[data-drawing-capture="true"]') as Element

    fireEvent.mouseDown(capture, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 200, clientY: 160 })
    await flushFrames()
    fireEvent.mouseUp(window)

    expect(useDrawingStore.getState().objects[0]).toMatchObject({ stroke: '#ffffff' })
  })

  it('keeps a user-chosen stroke even when the theme is dark', async () => {
    useThemeStore.getState().setMode('dark')
    useDrawingStore.getState().setToolOption('stroke', '#ef4444')
    useDrawingStore.getState().setTool('rectangle')
    const { container } = render(<DrawingLayer />)
    const capture = container.querySelector('[data-drawing-capture="true"]') as Element

    fireEvent.mouseDown(capture, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 200, clientY: 160 })
    await flushFrames()
    fireEvent.mouseUp(window)

    expect(useDrawingStore.getState().objects[0]).toMatchObject({ stroke: '#ef4444' })
  })

  it('cancels creation when liveObject is cleared (Escape)', async () => {
    useDrawingStore.getState().setTool('rectangle')
    const { container } = render(<DrawingLayer />)
    const capture = container.querySelector('[data-drawing-capture="true"]') as Element

    fireEvent.mouseDown(capture, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 200, clientY: 160 })
    await flushFrames()
    expect(useDrawingStore.getState().liveObject).not.toBeNull()

    // Escape (handled by InfiniteCanvas) clears liveObject — the gesture stops.
    await act(async () => {
      useDrawingStore.getState().setLiveObject(null)
    })
    fireEvent.mouseMove(window, { clientX: 300, clientY: 300 })
    await flushFrames()
    expect(useDrawingStore.getState().liveObject).toBeNull()

    fireEvent.mouseUp(window)
    expect(useDrawingStore.getState().objects).toHaveLength(0)
  })

  // ── Text editing ──────────────────────────────────────────

  it('double-clicking a text figure opens it for editing and commits on blur', () => {
    const id = useDrawingStore.getState().addObject({
      type: 'text',
      x: 10,
      y: 10,
      width: 200,
      height: 60,
      stroke: '#1e1e1e',
      strokeWidth: 2,
      fill: null,
      opacity: 1,
      text: 'Hello',
      fontSize: 18,
      fontFamily: 'sans',
      fontWeight: 400,
      textAlign: 'left',
    })
    const { container } = render(<DrawingLayer />)
    const figure = container.querySelector(`[data-figure-id="${id}"]`) as HTMLElement
    const editable = figure.querySelector('[contenteditable]') as HTMLElement
    expect(editable.getAttribute('contenteditable')).toBe('false')

    fireEvent.doubleClick(figure)
    expect(useDrawingStore.getState().editingTextId).toBe(id)
    const editing = figure.querySelector('[contenteditable="true"]') as HTMLElement
    expect(editing).toBeTruthy()
    expect(editing.textContent).toBe('Hello')

    editing.textContent = 'Hello World'
    fireEvent.blur(editing)
    expect(useDrawingStore.getState().objects[0]).toMatchObject({ text: 'Hello World' })
    expect(useDrawingStore.getState().editingTextId).toBeNull()
  })

  it('re-clicking a selected text figure (no drag) opens it for editing', () => {
    const id = useDrawingStore.getState().addObject({
      type: 'text',
      x: 10,
      y: 10,
      width: 200,
      height: 60,
      stroke: '#1e1e1e',
      strokeWidth: 2,
      fill: null,
      opacity: 1,
      text: 'Hi',
      fontSize: 18,
      fontFamily: 'sans',
      fontWeight: 400,
      textAlign: 'left',
    })
    useDrawingStore.getState().select([id])
    const { container } = render(<DrawingLayer />)
    const figure = container.querySelector(`[data-figure-id="${id}"]`) as Element

    fireEvent.mouseDown(figure, { button: 0, clientX: 50, clientY: 30 })
    fireEvent.mouseUp(window)

    expect(useDrawingStore.getState().editingTextId).toBe(id)
  })

  it('drags a text figure that is being edited (commits the text first)', async () => {
    const id = useDrawingStore.getState().addObject({
      type: 'text',
      x: 10,
      y: 10,
      width: 200,
      height: 60,
      stroke: '#1e1e1e',
      strokeWidth: 2,
      fill: null,
      opacity: 1,
      text: 'Hi',
      fontSize: 18,
      fontFamily: 'sans',
      fontWeight: 400,
      textAlign: 'left',
    })
    useDrawingStore.getState().setEditingTextId(id)
    const { container } = render(<DrawingLayer />)
    const figure = container.querySelector(`[data-figure-id="${id}"]`) as HTMLElement
    const editable = figure.querySelector('[contenteditable="true"]') as HTMLElement
    // The editing effect focused the editable div.
    expect(document.activeElement).toBe(editable)

    fireEvent.mouseDown(figure, { button: 0, clientX: 100, clientY: 100 })
    // First move crosses the threshold: commits the text, starts the gesture.
    fireEvent.mouseMove(window, { clientX: 140, clientY: 130 })
    // Gesture moves are measured from the original mousedown point.
    fireEvent.mouseMove(window, { clientX: 150, clientY: 140 })
    await flushFrames()
    fireEvent.mouseUp(window)

    // Text committed, editing ended, figure moved.
    expect(useDrawingStore.getState().editingTextId).toBeNull()
    expect(useDrawingStore.getState().objects[0]).toMatchObject({
      text: 'Hi',
      x: 60,
      y: 50,
    })
  })

  it('keeps editing a text figure on a plain caret click (no drag)', () => {
    const id = useDrawingStore.getState().addObject({
      type: 'text',
      x: 10,
      y: 10,
      width: 200,
      height: 60,
      stroke: '#1e1e1e',
      strokeWidth: 2,
      fill: null,
      opacity: 1,
      text: 'Hi',
      fontSize: 18,
      fontFamily: 'sans',
      fontWeight: 400,
      textAlign: 'left',
    })
    useDrawingStore.getState().setEditingTextId(id)
    const { container } = render(<DrawingLayer />)
    const figure = container.querySelector(`[data-figure-id="${id}"]`) as Element

    fireEvent.mouseDown(figure, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseUp(window)

    // No drag → still editing, figure untouched.
    expect(useDrawingStore.getState().editingTextId).toBe(id)
    expect(useDrawingStore.getState().objects[0]).toMatchObject({ x: 10, y: 10, text: 'Hi' })
  })

  it('removes a text figure committed with empty text', () => {
    const id = useDrawingStore.getState().addObject({
      type: 'text',
      x: 10,
      y: 10,
      width: 200,
      height: 60,
      stroke: '#1e1e1e',
      strokeWidth: 2,
      fill: null,
      opacity: 1,
      text: '',
      fontSize: 18,
      fontFamily: 'sans',
      fontWeight: 400,
      textAlign: 'left',
    })
    useDrawingStore.getState().setEditingTextId(id)
    const { container } = render(<DrawingLayer />)
    const figure = container.querySelector(`[data-figure-id="${id}"]`) as HTMLElement
    const editable = figure.querySelector('[contenteditable="true"]') as HTMLElement

    fireEvent.blur(editable)

    expect(useDrawingStore.getState().objects).toHaveLength(0)
    expect(useDrawingStore.getState().editingTextId).toBeNull()
  })

  it('shows a visible editing box while a text figure is being edited', () => {
    const id = useDrawingStore.getState().addObject({
      type: 'text',
      x: 10,
      y: 10,
      width: 200,
      height: 60,
      stroke: '#1e1e1e',
      strokeWidth: 2,
      fill: null,
      opacity: 1,
      text: '',
      fontSize: 18,
      fontFamily: 'sans',
      fontWeight: 400,
      textAlign: 'left',
    })
    useDrawingStore.getState().setEditingTextId(id)
    const { container } = render(<DrawingLayer />)
    const figure = container.querySelector(`[data-figure-id="${id}"]`) as HTMLElement
    expect(figure.getAttribute('style') ?? '').toContain('dashed')
  })

  // ── Move ──────────────────────────────────────────────────

  it('select tool: clicking a figure selects it and dragging moves it', async () => {
    const id = useDrawingStore.getState().addObject(toNewFigure(makeRect({ x: 100, y: 100 })))
    const { container } = render(<DrawingLayer />)
    const figure = container.querySelector(`[data-figure-id="${id}"]`) as Element

    fireEvent.mouseDown(figure, { button: 0, clientX: 150, clientY: 130 })
    expect(useDrawingStore.getState().selectedIds).toEqual([id])

    fireEvent.mouseMove(window, { clientX: 180, clientY: 150 })
    await flushFrames()

    // Moved on the compositor; the store is untouched until mouseup.
    expect(figure.getAttribute('transform')).toBe('translate(30, 20)')
    expect(useDrawingStore.getState().objects[0]).toMatchObject({ x: 100, y: 100 })

    fireEvent.mouseUp(window)
    expect(useDrawingStore.getState().objects[0]).toMatchObject({ x: 130, y: 120 })
    expect(figure.getAttribute('transform')).toBeNull()
  })

  // ── Resize ────────────────────────────────────────────────

  it('resize handle resizes a single selected figure', async () => {
    const id = useDrawingStore.getState().addObject(toNewFigure(makeRect({ x: 100, y: 100 })))
    useDrawingStore.getState().select([id])
    const { container } = render(<DrawingLayer />)
    const handle = container.querySelector('[data-figure-resize="true"]') as Element
    expect(handle).toBeTruthy()

    fireEvent.mouseDown(handle, { button: 0, clientX: 200, clientY: 160 })
    fireEvent.mouseMove(window, { clientX: 250, clientY: 200 })
    await flushFrames()

    // The rect was resized imperatively
    const rectEl = container.querySelector(`[data-figure-id="${id}"] rect`) as Element
    expect(rectEl.getAttribute('width')).toBe('150')
    expect(rectEl.getAttribute('height')).toBe('100')

    fireEvent.mouseUp(window)
    expect(useDrawingStore.getState().objects[0]).toMatchObject({ width: 150, height: 100 })
  })

  // ── Paste ─────────────────────────────────────────────────

  it('pasteImageAt adds an image figure centered on the point', async () => {
    vi.mocked(readClipboardImage).mockResolvedValue(
      new File(['x'], 'img.png', { type: 'image/png' })
    )
    vi.mocked(downscaleImageToDataUrl).mockResolvedValue({
      src: 'data:image/png;base64,AAA',
      width: 100,
      height: 50,
    })

    const id = await pasteImageAt(200, 150)
    expect(id).toBeTruthy()
    expect(useDrawingStore.getState().objects[0]).toMatchObject({
      type: 'image',
      x: 150,
      y: 125,
      width: 100,
      height: 50,
      src: 'data:image/png;base64,AAA',
    })
  })

  it('pasteImageAt is a no-op when the clipboard has no image', async () => {
    vi.mocked(readClipboardImage).mockResolvedValue(null)
    const id = await pasteImageAt(0, 0)
    expect(id).toBeNull()
    expect(useDrawingStore.getState().objects).toHaveLength(0)
  })

  it('click with the image tool pastes at the click point', async () => {
    vi.mocked(readClipboardImage).mockResolvedValue(
      new File(['x'], 'img.png', { type: 'image/png' })
    )
    vi.mocked(downscaleImageToDataUrl).mockResolvedValue({
      src: 'data:image/png;base64,AAA',
      width: 100,
      height: 50,
    })
    useDrawingStore.getState().setTool('image')
    const { container } = render(<DrawingLayer />)
    const capture = container.querySelector('[data-drawing-capture="true"]') as Element

    fireEvent.mouseDown(capture, { button: 0, clientX: 200, clientY: 150 })
    await act(async () => {})

    expect(useDrawingStore.getState().objects[0]).toMatchObject({
      type: 'image',
      x: 150,
      y: 125,
      width: 100,
      height: 50,
    })
  })
})
