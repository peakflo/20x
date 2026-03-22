import { useState, useEffect, useCallback } from 'react'
import { Loader2, Maximize2, Minimize2, ExternalLink, Square, AlertTriangle, Play, Code2 } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { marimoApi } from '@/lib/ipc-client'

interface MarimoEmbedProps {
  filePath: string
  /** Compact inline mode (in chat) vs standalone */
  compact?: boolean
}

type MarimoState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'not-installed' }
  | { phase: 'launching' }
  | { phase: 'running'; url: string }
  | { phase: 'error'; message: string }

export function MarimoEmbed({ filePath, compact = true }: MarimoEmbedProps) {
  const [state, setState] = useState<MarimoState>({ phase: 'idle' })
  const [fullscreen, setFullscreen] = useState(false)
  const [mode, setMode] = useState<'run' | 'edit'>('run')

  const fileName = filePath.split('/').pop() || filePath

  const launch = useCallback(async (launchMode: 'run' | 'edit' = mode) => {
    setState({ phase: 'checking' })
    try {
      // Check if already running
      const status = await marimoApi.status(filePath)
      if (status.running && status.url) {
        setState({ phase: 'running', url: status.url })
        return
      }

      // Check if marimo is installed
      const check = await marimoApi.check()
      if (!check.installed) {
        setState({ phase: 'not-installed' })
        return
      }

      setState({ phase: 'launching' })
      const result = await marimoApi.launch(filePath, launchMode)
      setMode(launchMode)
      setState({ phase: 'running', url: result.url })
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [filePath, mode])

  const stop = useCallback(async () => {
    await marimoApi.stop(filePath)
    setState({ phase: 'idle' })
    setFullscreen(false)
  }, [filePath])

  // Check on mount if already running
  useEffect(() => {
    marimoApi.status(filePath).then((status) => {
      if (status.running && status.url) {
        setState({ phase: 'running', url: status.url })
      }
    }).catch(() => { /* ignore */ })
  }, [filePath])

  // Idle state — show launch button
  if (state.phase === 'idle') {
    return (
      <div className="rounded-md bg-[#161b22] border border-primary/30 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Code2 className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs font-medium text-foreground truncate">{fileName}</span>
          <span className="text-[10px] text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded-full shrink-0">marimo notebook</span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="default"
              size="sm"
              onClick={() => launch('run')}
              className="h-7 px-3 text-xs gap-1.5"
            >
              <Play className="h-3 w-3" />
              Run
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => launch('edit')}
              className="h-7 px-2 text-xs"
              title="Open in edit mode"
            >
              <Code2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Not installed
  if (state.phase === 'not-installed') {
    return (
      <div className="rounded-md bg-[#161b22] border border-yellow-500/30 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 text-yellow-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-foreground block">{fileName}</span>
            <span className="text-[10px] text-muted-foreground">
              marimo is not installed. Run: <code className="text-yellow-300 bg-yellow-500/10 px-1 rounded">pip install marimo</code>
            </span>
          </div>
        </div>
      </div>
    )
  }

  // Checking / Launching
  if (state.phase === 'checking' || state.phase === 'launching') {
    return (
      <div className="rounded-md bg-[#161b22] border border-primary/30 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-3">
          <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />
          <span className="text-xs text-muted-foreground">
            {state.phase === 'checking' ? 'Checking marimo...' : `Starting marimo ${mode} server...`}
          </span>
        </div>
      </div>
    )
  }

  // Error
  if (state.phase === 'error') {
    return (
      <div className="rounded-md bg-[#161b22] border border-red-500/30 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-red-300 block">{state.message}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => launch()} className="h-7 px-2 text-xs shrink-0">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  // Running — show embedded iframe
  const iframeContent = (
    <div className={`flex flex-col ${fullscreen ? 'h-full' : compact ? 'h-[400px]' : 'h-[600px]'}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0d1117] border-b border-border/30 shrink-0">
        <Code2 className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium text-foreground truncate">{fileName}</span>
        <span className="text-[10px] text-green-400 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
          {mode === 'edit' ? 'editing' : 'running'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {mode === 'run' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { stop().then(() => launch('edit')) }}
              className="h-6 px-2 text-[10px]"
              title="Switch to edit mode"
            >
              <Code2 className="h-3 w-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.electronAPI.shell.openExternal(state.url)}
            className="h-6 px-2 text-[10px]"
            title="Open in browser"
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
          {!fullscreen && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFullscreen(true)}
              className="h-6 px-2 text-[10px]"
              title="Fullscreen"
            >
              <Maximize2 className="h-3 w-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={stop}
            className="h-6 px-2 text-[10px] text-red-400 hover:text-red-300"
            title="Stop server"
          >
            <Square className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* iframe */}
      <iframe
        src={state.url}
        className="flex-1 w-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-forms"
        allow="clipboard-write"
      />
    </div>
  )

  return (
    <>
      <div className="rounded-md bg-[#161b22] border border-primary/30 overflow-hidden">
        {!fullscreen && iframeContent}
        {fullscreen && (
          <div className="flex items-center gap-2 px-3 py-2.5">
            <Code2 className="h-4 w-4 text-primary shrink-0" />
            <span className="text-xs font-medium text-foreground">{fileName}</span>
            <span className="text-[10px] text-green-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
              {mode} — fullscreen
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFullscreen(false)}
              className="ml-auto h-6 px-2 text-[10px]"
            >
              <Minimize2 className="h-3 w-3" /> Back to inline
            </Button>
          </div>
        )}
      </div>

      {/* Fullscreen dialog */}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="max-w-[98vw] max-h-[95vh] w-[98vw] h-[95vh] p-0 overflow-hidden">
          {iframeContent}
        </DialogContent>
      </Dialog>
    </>
  )
}
