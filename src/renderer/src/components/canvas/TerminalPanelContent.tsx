import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelContentProps {
  terminalId: string
}

/**
 * Interactive terminal panel on the canvas.
 * Spawns a real shell (via node-pty in the main process) and renders it with xterm.js.
 */
export function TerminalPanelContent({ terminalId }: TerminalPanelContentProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cleanupRef = useRef<(() => void)[]>([])

  const initTerminal = useCallback(async () => {
    if (!containerRef.current || xtermRef.current) return

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
    fitAddon.fit()

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    try {
      // Create PTY in main process
      await window.electronAPI.terminal.create(
        terminalId,
        term.cols,
        term.rows
      )

      // Forward terminal input to PTY
      const inputDispose = term.onData((data) => {
        window.electronAPI.terminal.write(terminalId, data)
      })

      // Receive PTY output
      const removeDataListener = window.electronAPI.terminal.onData(({ id, data }) => {
        if (id === terminalId) {
          term.write(data)
        }
      })

      // Handle PTY exit
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
  }, [terminalId])

  // Initialize on mount
  useEffect(() => {
    initTerminal()

    return () => {
      // Cleanup listeners
      for (const fn of cleanupRef.current) fn()
      cleanupRef.current = []

      // Kill PTY
      window.electronAPI.terminal.kill(terminalId).catch(() => {})

      // Dispose xterm
      xtermRef.current?.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [initTerminal, terminalId])

  // Resize observer — fit terminal when panel resizes
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return

    const observer = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit()
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
    return () => observer.disconnect()
  }, [terminalId, isReady])

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
      style={{ background: '#141a26' }}
    />
  )
}
