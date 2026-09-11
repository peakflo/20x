import { useEffect, useState } from 'react'
import type { TaskConfirmation } from '@shared/task-confirmation'
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/components/ui/AlertDialog'

export function TaskActionConfirmation() {
  const [request, setRequest] = useState<TaskConfirmation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let received = false
    let mounted = true
    const update = (next: TaskConfirmation | null) => { setRequest(next); setBusy(false); setError('') }
    const unsubscribe = window.electronAPI.taskConfirmation.onChanged(next => { received = true; update(next) })
    void window.electronAPI.taskConfirmation.current().then(next => { if (mounted && !received) update(next) }).catch(error => console.error('Could not load task confirmation', error))
    return () => { mounted = false; unsubscribe() }
  }, [])
  const answer = async (approved: boolean) => {
    if (!request || busy) return
    setBusy(true); setError('')
    try { await window.electronAPI.taskConfirmation.answer(request.id, approved) }
    catch { setError('Could not send your answer. Please try again.'); setBusy(false) }
  }
  return (
    <AlertDialog open={!!request} onOpenChange={open => { if (!open) void answer(false) }}>
      <AlertDialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-4">
        <AlertDialogTitle className="max-h-[20dvh] shrink-0 overflow-y-auto [overflow-wrap:anywhere]">{request?.title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div role="region" aria-label="Task action details" tabIndex={0} className="min-h-0 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{request?.detail}</div>
        </AlertDialogDescription>
        {error && <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p>}
        <AlertDialogFooter className="mt-0 shrink-0 flex-wrap">
          <AlertDialogCancel disabled={busy} onClick={event => { event.preventDefault(); void answer(false) }}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void answer(true) }}>{request?.confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
