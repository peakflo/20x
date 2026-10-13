import { useState } from 'react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'

const CURSOR_INSTALL_URL = 'https://cursor.com/docs/cli/installation'

interface CursorCliSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRetry: () => Promise<void>
}

export function CursorCliSetupDialog({ open, onOpenChange, onRetry }: CursorCliSetupDialogProps) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const installCommand = navigator.userAgent.includes('Windows')
    ? "irm 'https://cursor.com/install?win32=true' | iex"
    : 'curl https://cursor.com/install -fsS | bash'

  const retry = async () => {
    setChecking(true)
    setError('')
    try {
      const status = await window.electronAPI.agentInstaller.detect()
      if (!status.cursor?.installed) {
        setError('cursor-agent is still not in 20x’s PATH. Install the Cursor CLI, then try again.')
        return
      }
      await onRetry()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setChecking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Install Cursor CLI</DialogTitle></DialogHeader>
        <DialogBody className="space-y-4">
          <DialogDescription>
            Cursor CLI (<code>cursor-agent</code>) is not installed or is not in 20x’s PATH. Install it, then retry this task.
          </DialogDescription>
          <code className="block rounded bg-muted p-3 text-xs break-all">{installCommand}</code>
          <a href={CURSOR_INSTALL_URL} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">
            Open Cursor’s official installation instructions
          </a>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={() => void retry()} disabled={checking}>{checking ? 'Checking…' : 'Retry task'}</Button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
