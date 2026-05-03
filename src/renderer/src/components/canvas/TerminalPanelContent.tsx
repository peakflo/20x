import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useCanvasStore } from '@/stores/canvas-store'
import { useUIStore } from '@/stores/ui-store'
import '@xterm/xterm/css/xterm.css'

/** Terminal theme palettes keyed by light/dark mode */
const TERMINAL_THEMES = {
  dark: {
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
  light: {
    background: '#FFFFFF',
    foreground: '#1A1C1F',
    cursor: '#0969DA',
    selectionBackground: '#B6D5F7',
    black: '#24292F',
    red: '#CF222E',
    green: '#116329',
    yellow: '#9A6700',
    blue: '#0969DA',
    magenta: '#8250DF',
    cyan: '#1B7C83',
    white: '#6E7781',
    brightBlack: '#57606A',
    brightRed: '#A40E26',
    brightGreen: '#1A7F37',
    brightYellow: '#7D4E00',
    brightBlue: '#218BFF',
    brightMagenta: '#A475F9',
    brightCyan: '#3192AA',
    brightWhite: '#8C959F',
  },
} as const

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
  const isReadyRef = useRef(false)
  const activePidRef = useRef<number | null>(null)
  const isMountedRef = useRef(true)

  // Store cwd in a ref — only used at init time, never triggers re-init
  const cwdRef = useRef(cwd)

  // Resolve terminal theme from current app theme
  const resolvedTheme = useUIStore((s) => {
    const t = s.theme
    if (t === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return t
  })
  const termTheme = TERMINAL_THEMES[resolvedTheme]

  const initTerminal = useCallback(async () => {
    console.log(`[Terminal:${terminalId}] initTerminal called`, {
      hasContainer: !!containerRef.current,
      hasXterm: !!xtermRef.current,
      initCalled: initCalledRef.current,
    })
    if (!containerRef.current || xtermRef.current || initCalledRef.current) return

    // Wait until the container actually has dimensions.
    // During canvas viewport changes or panel open animations the container
    // may still be 0×0 when this runs.
    const rect = containerRef.current.getBoundingClientRect()
    console.log(`[Terminal:${terminalId}] container rect`, { w: rect.width, h: rect.height })
    if (rect.width < 10 || rect.height < 10) return

    initCalledRef.current = true

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.2,
      theme: termTheme,
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
      const { pid } = await window.electronAPI.terminal.create(
        terminalId,
        term.cols,
        term.rows,
        cwdRef.current // read from ref, not prop — stable reference
      )

      // StrictMode / fast remount can unmount this instance before create() resolves.
      // In that case, kill only the PTY we just created and let the live instance continue.
      if (!isMountedRef.current || xtermRef.current !== term) {
        await window.electronAPI.terminal.kill(terminalId, pid).catch(() => {})
        return
      }

      activePidRef.current = pid

      console.log(`[Terminal:${terminalId}] PTY created, setting up listeners`)

      const inputDispose = term.onData((data) => {
        window.electronAPI.terminal.write(terminalId, data)
      })

      const removeDataListener = window.electronAPI.terminal.onData(({ id, data }) => {
        if (id === terminalId) {
          term.write(data)
        }
      })

      let processExited = false

      const removeExitListener = window.electronAPI.terminal.onExit(({ id }) => {
        if (id === terminalId) {
          processExited = true
          term.write('\r\n\x1b[90m[Process exited — press Enter to restart]\x1b[0m\r\n')
        }
      })

      // Respawn the shell when the user presses Enter after exit
      const respawnDispose = term.onKey(({ domEvent }) => {
        if (processExited && domEvent.key === 'Enter') {
          processExited = false
          term.clear()
          window.electronAPI.terminal.create(
            terminalId,
            term.cols,
            term.rows,
            cwdRef.current
          ).then(({ pid }) => {
            activePidRef.current = pid
            term.focus()
          }).catch(() => {
            processExited = true
            term.write('\r\n\x1b[90m[Failed to restart shell]\x1b[0m\r\n')
          })
        }
      })

      cleanupRef.current = [
        () => inputDispose.dispose(),
        () => respawnDispose.dispose(),
        removeDataListener,
        removeExitListener,
      ]

      // Focus the terminal so it can receive keyboard input
      console.log(`[Terminal:${terminalId}] calling term.focus(), textarea exists:`, !!term.textarea)
      term.focus()
      // Verify focus actually took
      setTimeout(() => {
        console.log(`[Terminal:${terminalId}] after focus, activeElement:`, document.activeElement?.tagName, document.activeElement?.className)
      }, 100)

      isReadyRef.current = true
      setIsReady(true)
    } catch (err) {
      console.error('Failed to create terminal:', err)
      setError(err instanceof Error ? err.message : 'Failed to create terminal')
    }
  }, [terminalId]) // cwd intentionally NOT a dep — read from cwdRef at init

  // Use ResizeObserver to detect when the container first gets real
  // dimensions, then initialize xterm. This is the primary guard
  // against the toFixed crash — we never call term.open() on a
  // zero-size container.
  useEffect(() => {
    if (!containerRef.current) return
    isMountedRef.current = true

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
        if (xtermRef.current && isReadyRef.current) {
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
      const expectedPid = activePidRef.current ?? undefined
      isMountedRef.current = false

      if (expectedPid !== undefined) {
        // Capture cwd before killing the terminal — persists across restarts.
        // Skip ID-only cleanup when this instance never acquired a PTY pid.
        window.electronAPI.terminal.getCwd(terminalId, expectedPid).then(({ cwd: currentCwd }) => {
          if (currentCwd) {
            useCanvasStore.getState().updatePanel(terminalId, { url: currentCwd })
          }
        }).catch(() => {}).finally(() => {
          window.electronAPI.terminal.kill(terminalId, expectedPid).catch(() => {})
        })
      }

      // Cleanup listeners
      for (const fn of cleanupRef.current) fn()
      cleanupRef.current = []

      // Dispose xterm
      xtermRef.current?.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
      initCalledRef.current = false
      isReadyRef.current = false
      activePidRef.current = null
    }
  }, [initTerminal, terminalId])

  // ── Periodically capture cwd so it persists on crash/force-quit ──
  // Uses direct IPC + store update — does NOT change any props that would
  // trigger re-initialization of the terminal.
  useEffect(() => {
    if (!isReady) return
    const interval = setInterval(async () => {
      try {
        const expectedPid = activePidRef.current ?? undefined
        const { cwd: currentCwd } = await window.electronAPI.terminal.getCwd(terminalId, expectedPid)
        if (currentCwd) {
          useCanvasStore.getState().updatePanel(terminalId, { url: currentCwd })
        }
      } catch { /* ignore */ }
    }, 30_000) // every 30 seconds (less aggressive)
    return () => clearInterval(interval)
  }, [isReady, terminalId])

  // ── Update xterm colors when the app theme changes ──
  useEffect(() => {
    const term = xtermRef.current
    if (!term?.options) return
    term.options.theme = termTheme
    // Update container background to match
    if (containerRef.current) {
      containerRef.current.style.background = termTheme.background
    }
  }, [termTheme])

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

  // Focus the terminal when the container is clicked
  const handleClick = useCallback(() => {
    console.log(`[Terminal:${terminalId}] container clicked, focusing. hasXterm:`, !!xtermRef.current, 'textarea:', !!xtermRef.current?.textarea)
    xtermRef.current?.focus()
    setTimeout(() => {
      console.log(`[Terminal:${terminalId}] after click-focus, activeElement:`, document.activeElement?.tagName, document.activeElement?.className)
    }, 50)
  }, [terminalId])

  return (
    <div
      ref={containerRef}
      className="h-full w-full xterm-container"
      onClick={handleClick}
      style={{
        background: termTheme.background,
        // Minimum dimensions prevent xterm's internal canvas renderer from
        // computing NaN cell sizes (which causes the toFixed crash).
        minWidth: 100,
        minHeight: 50,
      }}
    />
  )
}
