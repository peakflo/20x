import { useCallback, useRef, useState, useEffect, useMemo, type CSSProperties } from 'react'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import type { SnapGuide, CanvasPanelData, Viewport } from '@/stores/canvas-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskStore } from '@/stores/task-store'
import { CanvasPanel } from './CanvasPanel'
import { CanvasConnections } from './CanvasConnections'
import { CanvasContextMenu } from './CanvasContextMenu'
import { CanvasMinimap } from './CanvasMinimap'
import { ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ArrowUpRight, Move, ZoomIn, ZoomOut, RotateCcw, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { TaskStatus } from '@/types'
import { getCanvasTaskStatusStyle, shouldPulseCanvasTaskStatusTransition } from './canvas-status-style'

/**
 * Check if a panel is visible in the current viewport (with generous margin).
 * Off-viewport panels get "frozen" — their heavy content (iframes, terminals)
 * is hidden to save resources.
 */
function isPanelVisible(
  panel: CanvasPanelData,
  viewport: Viewport,
  containerWidth: number,
  containerHeight: number
): boolean {
  if (!containerWidth || !containerHeight) return true // assume visible if unknown

  // Visible region in canvas coordinates
  const margin = 200 // generous margin to avoid flickering at edges
  const visibleLeft = -viewport.x / viewport.zoom - margin
  const visibleTop = -viewport.y / viewport.zoom - margin
  const visibleRight = visibleLeft + containerWidth / viewport.zoom + margin * 2
  const visibleBottom = visibleTop + containerHeight / viewport.zoom + margin * 2

  const panelRight = panel.x + panel.width
  const panelBottom = panel.y + panel.height

  // AABB overlap test
  return (
    panel.x < visibleRight &&
    panelRight > visibleLeft &&
    panel.y < visibleBottom &&
    panelBottom > visibleTop
  )
}

// Grid dot spacing in canvas-space pixels
const GRID_SIZE = 40
const STATUS_HIGHLIGHT_MS = 5_000
const STATUS_POPUP_EDGE_PAD = 28
const STATUS_POPUP_TOP_SAFE = 70
const STATUS_POPUP_BOTTOM_SAFE = 150
const STATUS_POPUP_LEFT_SAFE = 170
const STATUS_POPUP_RIGHT_SAFE = 220

interface StatusHighlight {
  id: string
  taskId: string
  panelId: string
  title: string
  rgb: string
  x: number
  y: number
  width: number
  height: number
}

function getPanelScreenRect(panel: StatusHighlight, viewport: Viewport) {
  return {
    left: panel.x * viewport.zoom + viewport.x,
    top: panel.y * viewport.zoom + viewport.y,
    width: panel.width * viewport.zoom,
    height: panel.height * viewport.zoom,
  }
}

type StatusPopupDirection = 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

function getVectorDirection(deltaX: number, deltaY: number): StatusPopupDirection {
  const deadZone = 0.35
  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)

  if (absX > absY * deadZone && absY > absX * deadZone) {
    if (deltaX < 0 && deltaY < 0) return 'top-left'
    if (deltaX > 0 && deltaY < 0) return 'top-right'
    if (deltaX < 0 && deltaY > 0) return 'bottom-left'
    return 'bottom-right'
  }
  if (absX >= absY) return deltaX < 0 ? 'left' : 'right'
  return deltaY < 0 ? 'top' : 'bottom'
}

function getOffscreenBeacon(
  highlight: StatusHighlight,
  viewport: Viewport,
  containerWidth: number,
  containerHeight: number
): { style: CSSProperties; direction: StatusPopupDirection } | null {
  if (!containerWidth || !containerHeight) return null

  const rect = getPanelScreenRect(highlight, viewport)
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const isVisible =
    rect.left < containerWidth &&
    rect.left + rect.width > 0 &&
    rect.top < containerHeight &&
    rect.top + rect.height > 0

  if (isVisible) return null

  const safeMinX = Math.min(containerWidth - STATUS_POPUP_EDGE_PAD, Math.max(STATUS_POPUP_EDGE_PAD, STATUS_POPUP_LEFT_SAFE))
  const safeMaxX = Math.max(STATUS_POPUP_EDGE_PAD, containerWidth - STATUS_POPUP_RIGHT_SAFE)
  const safeMinY = Math.min(containerHeight - STATUS_POPUP_EDGE_PAD, Math.max(STATUS_POPUP_EDGE_PAD, STATUS_POPUP_TOP_SAFE))
  const safeMaxY = Math.max(STATUS_POPUP_EDGE_PAD, containerHeight - STATUS_POPUP_BOTTOM_SAFE)
  const leftDistance = Math.abs(centerX)
  const rightDistance = Math.abs(centerX - containerWidth)
  const topDistance = Math.abs(centerY)
  const bottomDistance = Math.abs(centerY - containerHeight)
  const nearest = Math.min(leftDistance, rightDistance, topDistance, bottomDistance)
  const side =
    nearest === leftDistance ? 'left'
      : nearest === rightDistance ? 'right'
        : nearest === topDistance ? 'top'
          : 'bottom'
  const x = side === 'left'
    ? STATUS_POPUP_EDGE_PAD
    : side === 'right'
      ? containerWidth - STATUS_POPUP_EDGE_PAD
      : Math.min(safeMaxX, Math.max(safeMinX, centerX))
  const y = side === 'top'
    ? STATUS_POPUP_EDGE_PAD
    : side === 'bottom'
      ? containerHeight - STATUS_POPUP_EDGE_PAD
      : Math.min(safeMaxY, Math.max(safeMinY, centerY))
  const direction = getVectorDirection(centerX - containerWidth / 2, centerY - containerHeight / 2)
  return {
    direction,
    style: {
      left: x,
      top: y,
      transform: 'translate(-50%, -50%)',
      '--canvas-status-rgb': highlight.rgb,
    } as CSSProperties,
  }
}

/**
 * InfiniteCanvas — the main canvas screen.
 *
 * Supports:
 * - Mouse-wheel zoom (with Ctrl/Meta for pinch-to-zoom on trackpads)
 * - Click-drag panning
 * - Trackpad two-finger pan (wheel events without ctrl)
 * - Pinch-to-zoom on trackpad (wheel events with ctrlKey)
 * - Keyboard shortcuts (space+drag for pan, +/- for zoom, Delete to remove selected)
 * - Panel rendering at canvas coordinates via CSS transforms
 * - Right-click context menu to add panels
 * - Panel connections (visual edges)
 * - Snap guides during drag
 */
export function InfiniteCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const previousTaskStatusRef = useRef(new Map<string, TaskStatus>())
  const viewport = useCanvasStore((s) => s.viewport)
  const panels = useCanvasStore((s) => s.panels)
  const snapGuides = useCanvasStore((s) => s.snapGuides)
  const isLoaded = useCanvasStore((s) => s.isLoaded)
  const panBy = useCanvasStore((s) => s.panBy)
  const zoomAtPoint = useCanvasStore((s) => s.zoomAtPoint)
  const zoomTo = useCanvasStore((s) => s.zoomTo)
  const resetViewport = useCanvasStore((s) => s.resetViewport)
  const fitToContent = useCanvasStore((s) => s.fitToContent)
  const focusPanel = useCanvasStore((s) => s.focusPanel)
  const addPanel = useCanvasStore((s) => s.addPanel)
  const loadCanvas = useCanvasStore((s) => s.loadCanvas)

  // ── Load persisted canvas state on mount ────────────────
  useEffect(() => {
    if (!isLoaded) {
      loadCanvas().then(() => {
        // After loading, fit the viewport to show all panels
        const container = containerRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          const { panels: loadedPanels } = useCanvasStore.getState()
          if (loadedPanels.length > 0) {
            fitToContent(rect.width, rect.height)
          }
        }
      })
    }
  }, [isLoaded, loadCanvas, fitToContent])

  // Panning state
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    clientX: number
    clientY: number
    canvasX: number
    canvasY: number
  } | null>(null)
  const [statusHighlights, setStatusHighlights] = useState<StatusHighlight[]>([])

  // Connection drawing state
  const connectingFromId = useCanvasStore((s) => s.connectingFromId)
  const setConnectingFromId = useCanvasStore((s) => s.setConnectingFromId)
  const [mouseCanvasPos, setMouseCanvasPos] = useState<{ x: number; y: number } | null>(null)

  // Track container size for viewport visibility culling
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Compute which panels are visible in the current viewport
  const visiblePanelIds = useMemo(() => {
    const set = new Set<string>()
    for (const p of panels) {
      if (isPanelVisible(p, viewport, containerSize.width, containerSize.height)) {
        set.add(p.id)
      }
    }
    return set
  }, [panels, viewport, containerSize])

  // ── Consume pending task from "Open in Canvas" button ────
  const canvasPendingTaskId = useUIStore((s) => s.canvasPendingTaskId)
  const clearCanvasPendingTask = useUIStore((s) => s.clearCanvasPendingTask)
  const canvasPendingApp = useUIStore((s) => s.canvasPendingApp)
  const clearCanvasPendingApp = useUIStore((s) => s.clearCanvasPendingApp)
  const allTasks = useTaskStore((s) => s.tasks)

  useEffect(() => {
    const previousStatuses = previousTaskStatusRef.current
    const taskPanels = new Map<string, CanvasPanelData>()
    for (const panel of panels) {
      if (panel.type === 'task' && panel.refId) taskPanels.set(panel.refId, panel)
    }

    for (const task of allTasks) {
      const previous = previousStatuses.get(task.id)
      previousStatuses.set(task.id, task.status)

      if (!shouldPulseCanvasTaskStatusTransition(previous, task.status)) {
        continue
      }

      const panel = taskPanels.get(task.id)
      if (!panel) continue
      const statusStyle = getCanvasTaskStatusStyle(task.status)

      const highlight: StatusHighlight = {
        id: `${task.id}-${Date.now()}`,
        taskId: task.id,
        panelId: panel.id,
        title: task.title,
        rgb: statusStyle?.rgb ?? '59,130,246',
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height,
      }
      setStatusHighlights((current) => [...current.filter((item) => item.taskId !== task.id), highlight])
      window.setTimeout(() => {
        setStatusHighlights((current) => current.filter((item) => item.id !== highlight.id))
      }, STATUS_HIGHLIGHT_MS)
    }
  }, [allTasks, panels])

  useEffect(() => {
    if (!canvasPendingTaskId) return
    // Clear immediately to prevent double-fire on re-render
    clearCanvasPendingTask()

    const task = allTasks.find((t) => t.id === canvasPendingTaskId)
    if (!task) return

    // Read panels from store directly to avoid stale closure
    const currentPanels = useCanvasStore.getState().panels
    const alreadyExists = currentPanels.some(
      (p) => p.type === 'task' && p.refId === canvasPendingTaskId
    )
    if (alreadyExists) return

    // Place at center of viewport
    const container = containerRef.current
    const rect = container?.getBoundingClientRect()
    const vp = useCanvasStore.getState().viewport
    const centerX = rect
      ? (rect.width / 2 - vp.x) / vp.zoom - DEFAULT_PANEL_WIDTH / 2
      : 0
    const centerY = rect
      ? (rect.height / 2 - vp.y) / vp.zoom - DEFAULT_PANEL_HEIGHT / 2
      : 0
    const offset = (currentPanels.length % 5) * 30
    addPanel({
      type: 'task',
      title: task.title,
      refId: task.id,
      x: centerX + offset,
      y: centerY + offset,
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
    })
  }, [canvasPendingTaskId])

  // ── Consume pending app from "Open in Canvas" button ────
  useEffect(() => {
    if (!canvasPendingApp) return
    const { workflowId, name } = canvasPendingApp
    clearCanvasPendingApp()

    const currentPanels = useCanvasStore.getState().panels
    const alreadyExists = currentPanels.some(
      (p) => p.type === 'app' && p.refId === workflowId
    )
    if (alreadyExists) return

    const container = containerRef.current
    const rect = container?.getBoundingClientRect()
    const vp = useCanvasStore.getState().viewport
    const centerX = rect
      ? (rect.width / 2 - vp.x) / vp.zoom - DEFAULT_PANEL_WIDTH / 2
      : 0
    const centerY = rect
      ? (rect.height / 2 - vp.y) / vp.zoom - DEFAULT_PANEL_HEIGHT / 2
      : 0
    const offset = (currentPanels.length % 5) * 30
    addPanel({
      type: 'app',
      title: name,
      refId: workflowId,
      x: centerX + offset,
      y: centerY + offset,
      width: DEFAULT_PANEL_WIDTH,
      height: DEFAULT_PANEL_HEIGHT,
    })
  }, [canvasPendingApp])

  // ── Wheel handler (zoom + trackpad pan) ──────────────────
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const container = containerRef.current
      if (!container) return

      // Check if the wheel event is inside a scrollable panel element.
      // If so, let the panel scroll naturally instead of panning the canvas.
      // Exception: Ctrl/Meta+wheel is always zoom regardless of target.
      if (!(e.ctrlKey || e.metaKey)) {
        let el = e.target as HTMLElement | null
        while (el && el !== container) {
          // Check for data attribute marking panel content areas
          if (el.dataset?.canvasPanel === 'true') break // reached panel boundary, stop
          const style = window.getComputedStyle(el)
          const overflowY = style.overflowY
          const overflowX = style.overflowX
          const isScrollableY =
            (overflowY === 'auto' || overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight
          const isScrollableX =
            (overflowX === 'auto' || overflowX === 'scroll') &&
            el.scrollWidth > el.clientWidth

          if (isScrollableY || isScrollableX) {
            // Check if the element can still scroll in the direction of the wheel
            const canScrollDown = isScrollableY && e.deltaY > 0 && el.scrollTop < el.scrollHeight - el.clientHeight - 1
            const canScrollUp = isScrollableY && e.deltaY < 0 && el.scrollTop > 0
            const canScrollRight = isScrollableX && e.deltaX > 0 && el.scrollLeft < el.scrollWidth - el.clientWidth - 1
            const canScrollLeft = isScrollableX && e.deltaX < 0 && el.scrollLeft > 0

            if (canScrollDown || canScrollUp || canScrollRight || canScrollLeft) {
              // Let the nested element handle scroll naturally
              return
            }
          }
          el = el.parentElement
        }
      }

      e.preventDefault()

      if (e.ctrlKey || e.metaKey) {
        const rect = container.getBoundingClientRect()
        zoomAtPoint(e.deltaY, e.clientX, e.clientY, rect)
      } else {
        panBy(-e.deltaX, -e.deltaY)
      }
    },
    [panBy, zoomAtPoint]
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ── Mouse-drag panning ───────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Close context menu on any click
      if (contextMenu) {
        setContextMenu(null)
        return
      }

      // Cancel connection drawing on background click
      const { connectingFromId: cid } = useCanvasStore.getState()
      if (cid && e.button === 0) {
        const target = e.target as HTMLElement
        const isBackground = target === containerRef.current || target.dataset?.canvasBg === 'true'
        if (isBackground) {
          setConnectingFromId(null)
          setMouseCanvasPos(null)
          return
        }
      }

      const isMiddle = e.button === 1
      const isLeftOnCanvas =
        e.button === 0 &&
        (e.target === containerRef.current ||
          (e.target as HTMLElement).dataset?.canvasBg === 'true')
      const isSpacePan = e.button === 0 && spaceHeld

      if (isMiddle || isLeftOnCanvas || isSpacePan) {
        e.preventDefault()
        setIsPanning(true)
        panStartRef.current = { x: e.clientX, y: e.clientY }
      }
    },
    [spaceHeld, contextMenu]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Track mouse position in canvas space for connection line rendering
      if (connectingFromId) {
        const container = containerRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          const vp = useCanvasStore.getState().viewport
          setMouseCanvasPos({
            x: (e.clientX - rect.left - vp.x) / vp.zoom,
            y: (e.clientY - rect.top - vp.y) / vp.zoom,
          })
        }
      }

      if (!isPanning) return
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      panStartRef.current = { x: e.clientX, y: e.clientY }
      panBy(dx, dy)
    },
    [isPanning, panBy]
  )

  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
  }, [])

  // ── Context menu ─────────────────────────────────────────
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const canvasX = (e.clientX - rect.left - viewport.x) / viewport.zoom
      const canvasY = (e.clientY - rect.top - viewport.y) / viewport.zoom
      setContextMenu({
        clientX: e.clientX,
        clientY: e.clientY,
        canvasX,
        canvasY,
      })
    },
    [viewport]
  )

  // ── Focused panel tracking (for Tab cycling) ─────────────
  const [focusedPanelIndex, setFocusedPanelIndex] = useState(-1)

  // ── Ctrl-held state (shows panel index badges) ──────────
  const [ctrlHeld, setCtrlHeld] = useState(false)

  // ── Keyboard shortcuts ───────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcuts when typing in an input/textarea or xterm terminal
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const isXtermFocused = !!(e.target as HTMLElement)?.closest('.xterm')
      const isInputFocused = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable || isXtermFocused

      // Track Ctrl held state — shows panel index badges (Ctrl only, not Cmd)
      if (e.key === 'Control' && !e.repeat) {
        setCtrlHeld(true)
      }
      // Clear stale ctrlHeld if Ctrl was released while OS had focus
      // (e.g. after Ctrl+Cmd+Shift+3 screenshot, OS swallows the keyup)
      if (!e.ctrlKey && e.key !== 'Control') {
        setCtrlHeld(false)
      }

      if (e.code === 'Space' && !e.repeat && !isInputFocused) {
        setSpaceHeld(true)
      }
      if (e.code === 'Equal' && (e.ctrlKey || e.metaKey) && !isInputFocused) {
        e.preventDefault()
        zoomTo(viewport.zoom * 1.2)
      }
      if (e.code === 'Minus' && (e.ctrlKey || e.metaKey) && !isInputFocused) {
        e.preventDefault()
        zoomTo(viewport.zoom / 1.2)
      }
      if (e.code === 'Digit0' && (e.ctrlKey || e.metaKey) && !isInputFocused) {
        e.preventDefault()
        resetViewport()
      }

      // Ctrl/Cmd + 1-9: focus panel by index
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !isInputFocused) {
        const digitMatch = e.code.match(/^Digit([1-9])$/)
        if (digitMatch) {
          const idx = parseInt(digitMatch[1], 10) - 1
          const currentPanels = useCanvasStore.getState().panels
          if (idx < currentPanels.length) {
            e.preventDefault()
            const container = containerRef.current
            if (container) {
              const rect = container.getBoundingClientRect()
              useCanvasStore.getState().focusPanel(currentPanels[idx].id, rect.width, rect.height)
              setFocusedPanelIndex(idx)
            }
          }
        }
      }

      // Tab / Shift+Tab: cycle through panels
      if (e.code === 'Tab' && !isInputFocused && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        const currentPanels = useCanvasStore.getState().panels
        if (currentPanels.length === 0) return

        const next = e.shiftKey
          ? (focusedPanelIndex <= 0 ? currentPanels.length - 1 : focusedPanelIndex - 1)
          : (focusedPanelIndex >= currentPanels.length - 1 ? 0 : focusedPanelIndex + 1)

        setFocusedPanelIndex(next)
        const container = containerRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          useCanvasStore.getState().focusPanel(currentPanels[next].id, rect.width, rect.height)
        }
      }

      // Escape: cancel connecting or close context menu
      if (e.code === 'Escape') {
        const { connectingFromId: cid } = useCanvasStore.getState()
        if (cid) {
          setConnectingFromId(null)
          setMouseCanvasPos(null)
        }
        setContextMenu(null)
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpaceHeld(false)
      }
      if (e.key === 'Control') {
        setCtrlHeld(false)
      }
    }
    // Also clear on window blur (Ctrl+Tab to another window)
    const handleBlur = () => {
      setCtrlHeld(false)
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [viewport.zoom, zoomTo, resetViewport, focusedPanelIndex])

  const zoomPercent = Math.round(viewport.zoom * 100)

  const cursorStyle = isPanning || spaceHeld
      ? 'grabbing'
      : 'default'

  return (
    <div data-canvas-root="true" className="overflow-hidden bg-[var(--canvas-bg)]" style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Canvas container */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: cursorStyle }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
      >
        {/* Transformed layer */}
        <div
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: '0 0',
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 0,
          }}
        >
          {/* Background grid dots */}
          <CanvasGrid
            zoom={viewport.zoom}
            viewportX={viewport.x}
            viewportY={viewport.y}
            containerRef={containerRef}
          />

          {/* Snap guides */}
          <SnapGuides guides={snapGuides} containerRef={containerRef} viewport={viewport} />

          {/* Connection lines */}
          <CanvasConnections mouseCanvasPos={mouseCanvasPos} />

          {/* Render panels — off-viewport panels are frozen (content hidden) */}
          {panels.map((panel, index) => (
            <CanvasPanel
              key={panel.id}
              panel={panel}
              zoom={viewport.zoom}
              frozen={!visiblePanelIds.has(panel.id)}
              panelIndex={index}
              showIndex={ctrlHeld}
            />
          ))}
        </div>

        {/* Click target for background */}
        <div data-canvas-bg="true" className="absolute inset-0" style={{ zIndex: -1 }} />
      </div>

      {statusHighlights.map((highlight) => {
        const beacon = getOffscreenBeacon(highlight, viewport, containerSize.width, containerSize.height)
        if (!beacon) return null
        const DirectionIcon = beacon.direction === 'left'
          ? ArrowLeft
          : beacon.direction === 'right'
            ? ArrowRight
            : beacon.direction === 'top'
              ? ArrowUp
              : beacon.direction === 'top-left'
                ? ArrowUpLeft
                : beacon.direction === 'top-right'
                  ? ArrowUpRight
                  : beacon.direction === 'bottom-left'
                    ? ArrowDownLeft
                    : beacon.direction === 'bottom-right'
                      ? ArrowDownRight
                      : ArrowDown
        return (
          <div
            key={`${highlight.id}-beacon`}
            data-canvas-status-edge-highlight="true"
            data-direction={beacon.direction}
            className="absolute z-10"
            style={beacon.style}
            title={highlight.title}
          >
            <button
              type="button"
              className="canvas-status-jump-popup flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white shadow-lg backdrop-blur-sm"
              onClick={(e) => {
                e.stopPropagation()
                focusPanel(highlight.panelId, containerSize.width, containerSize.height)
                setStatusHighlights((current) => current.filter((item) => item.id !== highlight.id))
              }}
              title={`Jump to ${highlight.title}`}
            >
              <DirectionIcon className="h-4 w-4" />
            </button>
          </div>
        )
      })}

      {/* ── HUD: zoom controls ── */}
      <div className="absolute bottom-4 left-4 flex items-center gap-1 bg-[var(--canvas-toolbar)] backdrop-blur-sm border border-border/40 rounded-lg p-1 z-10">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => zoomTo(viewport.zoom / 1.2)}
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground w-10 text-center tabular-nums">
          {zoomPercent}%
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => zoomTo(viewport.zoom * 1.2)}
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <div className="w-px h-4 bg-border/30 mx-0.5" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={resetViewport}
          title="Reset view (Ctrl+0)"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── HUD: Add button (top-left, primary CTA) ── */}
      <div className="absolute top-3 left-3 z-10">
        <Button
          size="sm"
          className="h-8 px-3 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm text-xs gap-1.5"
          onClick={(e) => {
            const btn = e.currentTarget.getBoundingClientRect()
            const rect = containerRef.current?.getBoundingClientRect()
            if (!rect) return
            setContextMenu({
              clientX: btn.left,
              clientY: btn.bottom + 4,
              canvasX: (btn.left - rect.left - viewport.x) / viewport.zoom,
              canvasY: (btn.bottom + 4 - rect.top - viewport.y) / viewport.zoom,
            })
          }}
          title="Add to canvas"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Add</span>
        </Button>
      </div>

      {/* ── HUD: Viewport info (top-right) ── */}
      <div className="absolute top-3 right-3 flex items-center gap-2 text-[10px] text-muted-foreground/40 z-10 select-none">
        <Move className="h-3 w-3" />
        <span className="tabular-nums">
          {Math.round(-viewport.x / viewport.zoom)},{' '}
          {Math.round(-viewport.y / viewport.zoom)}
        </span>
      </div>

      {/* ── Minimap (bottom-right) ── */}
      <CanvasMinimap
        containerWidth={containerSize.width}
        containerHeight={containerSize.height}
      />

      {/* ── Empty state ── */}
      {panels.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
          <div className="text-center">
            <div className="text-muted-foreground/30 text-sm font-medium mb-1">
              Infinite Canvas
            </div>
            <div className="text-muted-foreground/20 text-xs">
              Scroll to pan &middot; Pinch or Ctrl+scroll to zoom &middot;
              Right-click to add tasks &amp; apps
            </div>
          </div>
        </div>
      )}

      {/* ── Context menu ── */}
      {contextMenu && (
        <CanvasContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

// ── Grid dots background ───────────────────────────────────

function CanvasGrid({
  zoom,
  viewportX,
  viewportY,
  containerRef,
}: {
  zoom: number
  viewportX: number
  viewportY: number
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const container = containerRef.current
  if (!container) return null

  const rect = container.getBoundingClientRect()
  // Guard against zero-size container (during window move/minimize transitions)
  if (!rect.width || !rect.height || !zoom) return null

  const visibleLeft = -viewportX / zoom
  const visibleTop = -viewportY / zoom
  const visibleWidth = rect.width / zoom
  const visibleHeight = rect.height / zoom

  const gridLeft = Math.floor(visibleLeft / GRID_SIZE) * GRID_SIZE - GRID_SIZE
  const gridTop = Math.floor(visibleTop / GRID_SIZE) * GRID_SIZE - GRID_SIZE
  const gridWidth = visibleWidth + GRID_SIZE * 3
  const gridHeight = visibleHeight + GRID_SIZE * 3

  const dotSize = Math.max(1, Math.min(2, 1.5 / zoom))

  return (
    <div
      style={{
        position: 'absolute',
        left: gridLeft,
        top: gridTop,
        width: gridWidth,
        height: gridHeight,
        backgroundImage: `radial-gradient(circle, var(--canvas-dot) ${dotSize}px, transparent ${dotSize}px)`,
        backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
        backgroundPosition: `${GRID_SIZE / 2}px ${GRID_SIZE / 2}px`,
        pointerEvents: 'none',
      }}
    />
  )
}

// ── Snap guide lines ───────────────────────────────────────

function SnapGuides({
  guides,
  containerRef,
  viewport,
}: {
  guides: SnapGuide[]
  containerRef: React.RefObject<HTMLDivElement | null>
  viewport: { x: number; y: number; zoom: number }
}) {
  if (guides.length === 0) return null

  const container = containerRef.current
  if (!container) return null

  const rect = container.getBoundingClientRect()
  if (!rect.width || !rect.height || !viewport.zoom) return null

  const visibleLeft = -viewport.x / viewport.zoom
  const visibleTop = -viewport.y / viewport.zoom
  const visibleWidth = rect.width / viewport.zoom
  const visibleHeight = rect.height / viewport.zoom

  return (
    <>
      {guides.map((guide, i) => (
        <div
          key={`${guide.axis}-${guide.position}-${i}`}
          className="absolute pointer-events-none"
          style={
            guide.axis === 'x'
              ? {
                  left: guide.position,
                  top: visibleTop - 1000,
                  width: 1,
                  height: visibleHeight + 2000,
                  background: 'rgba(30,150,235,0.25)',
                }
              : {
                  left: visibleLeft - 1000,
                  top: guide.position,
                  width: visibleWidth + 2000,
                  height: 1,
                  background: 'rgba(30,150,235,0.25)',
                }
          }
        />
      ))}
    </>
  )
}
