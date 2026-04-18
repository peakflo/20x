import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useCanvasStore } from '@/stores/canvas-store'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelContentProps {
  terminalId: string
  /** Initial working directory — restored from persisted panel state */
  cwd?: string
}

/**
 * Interactive terminal panel on the canvas.
 * Spawns a real shell (via the main process) and renders it with xterm.js.
 *
 * IMPORTANT: xterm.js's canvas renderer calls `.toFixed()` on computed
 * cell dimensions. When the container has 0×0 size (window drag, minimize,
 * canvas viewport transitions) those values become NaN, crashing with
 * "f.toFixed is not a function". To prevent this:
 *   1. We only open() xterm after a ResizeObserver confirms real dimensions.
 *   2. The container always has min-width/min-height so the renderer never
 *      sees truly-zero values even during layout shifts.
 *   3. Every fit() call is wrapped in try-catch.
 */
export function TerminalPanelContent({ terminalId, cwd }: TerminalPanelContentProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cleanupRef = useRef<(() => void)[]>([])
  const initCalledRef = useRef(false)

  const initTerminal = useCallback(async () => {
    if (!containerRef.current || xtermRef.current || initCalledRef.current) return

    // Wait until the container actually has dimensions.
    // During canvas viewport changes or panel open animations the container
    // may still be 0×0 when this runs.
    const rect = containerRef.current.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) return

    initCalledRef.current = true

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.2,
      theme: {
        background: '#141a26',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#141a26',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#c9d1d9',
        brightBlack: '#484f58',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    term.open(containerRef.current)
    try { fitAddon.fit() } catch { /* ignore fit errors during init */ }

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    // Wait two animation frames so xterm's renderer finishes computing
    // dimensions.css.canvas.width/height. Without this, the shell's
    // initial terminal-size query (CSI t) hits _reportWindowsOptions()
    // before dimensions are populated, causing ".toFixed is not a function".
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })

    // Bail if component was unmounted during the wait
    if (!xtermRef.current) return

    try {
      await window.electronAPI.terminal.create(
        terminalId,
        term.cols,
        term.rows,
        cwd
      )

      const inputDispose = term.onData((data) => {
        window.electronAPI.terminal.write(terminalId, data)
      })

      const removeDataListener = window.electronAPI.terminal.onData(({ id, data }) => {
        if (id === terminalId) {
          term.write(data)
        }
      })

      const removeExitListener = window.electronAPI.terminal.onExit(({ id }) => {
        if (id === terminalId) {
          term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n')
        }
      })

      cleanupRef.current = [
        () => inputDispose.dispose(),
        removeDataListener,
        removeExitListener,
      ]

      setIsReady(true)
    } catch (err) {
      console.error('Failed to create terminal:', err)
      setError(err instanceof Error ? err.message : 'Failed to create terminal')
    }
  }, [terminalId, cwd])

  // Use ResizeObserver to detect when the container first gets real
  // dimensions, then initialize xterm. This is the primary guard
  // against the toFixed crash — we never call term.open() on a
  // zero-size container.
  useEffect(() => {
    if (!containerRef.current) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect

      // ── First paint: init terminal once container is big enough ──
      if (!xtermRef.current && !initCalledRef.current && width >= 10 && height >= 10) {
        initTerminal()
        return
      }

      // ── Subsequent resizes: refit ──
      if (!xtermRef.current || !fitAddonRef.current) return
      if (width < 10 || height < 10) return // still too small — skip
      try {
        fitAddonRef.current.fit()
        if (xtermRef.current && isReady) {
          window.electronAPI.terminal.resize(
            terminalId,
            xtermRef.current.cols,
            xtermRef.current.rows
          ).catch(() => {})
        }
      } catch {
        // ignore fit errors during transitions
      }
    })

    observer.observe(containerRef.current)

    // Also try to init immediately if container already has dimensions
    // (common path — panel is already visible when component mounts)
    initTerminal()

    return () => {
      observer.disconnect()

      // Capture cwd before killing the terminal — persists across restarts
      window.electronAPI.terminal.getCwd(terminalId).then(({ cwd: currentCwd }) => {
        if (currentCwd) {
          useCanvasStore.getState().updatePanel(terminalId, { url: currentCwd })
        }
      }).catch(() => {}).finally(() => {
        // Kill PTY after cwd capture attempt
        window.electronAPI.terminal.kill(terminalId).catch(() => {})
      })

      // Cleanup listeners
      for (const fn of cleanupRef.current) fn()
      cleanupRef.current = []

      // Dispose xterm
      xtermRef.current?.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
      initCalledRef.current = false
    }
  }, [initTerminal, terminalId, isReady])

  // ── Periodically capture cwd so it persists on crash/force-quit ──
  useEffect(() => {
    if (!isReady) return
    const interval = setInterval(async () => {
      try {
        const { cwd: currentCwd } = await window.electronAPI.terminal.getCwd(terminalId)
        if (currentCwd) {
          useCanvasStore.getState().updatePanel(terminalId, { url: currentCwd })
        }
      } catch { /* ignore */ }
    }, 10_000) // every 10 seconds
    return () => clearInterval(interval)
  }, [isReady, terminalId])

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400/60 text-xs">
        <div className="text-center space-y-1">
          <div>Terminal Error</div>
          <div className="text-[10px] text-muted-foreground/40">{error}</div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{
        background: '#141a26',
        // Minimum dimensions prevent xterm's internal canvas renderer from
        // computing NaN cell sizes (which causes the toFixed crash).
        minWidth: 100,
        minHeight: 50,
      }}
    />
  )
}
