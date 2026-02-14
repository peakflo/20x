import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/AlertDialog'

interface RestartSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onKeepProgress: () => void
  onStartFresh: () => void
}

export function RestartSessionDialog({ open, onOpenChange, onKeepProgress, onStartFresh }: RestartSessionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart Agent Session</AlertDialogTitle>
          <AlertDialogDescription>
            How would you like to restart the agent session for this task?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 py-4">
          <button
            onClick={() => {
              onKeepProgress()
              onOpenChange(false)
            }}
            className="w-full p-4 text-left rounded-md border border-border hover:bg-accent/50 transition-colors"
          >
            <div className="font-medium">Keep Progress</div>
            <div className="text-sm text-muted-foreground mt-1">
              Resume from where the agent left off. All conversation history and context will be preserved.
            </div>
          </button>
          <button
            onClick={() => {
              onStartFresh()
              onOpenChange(false)
            }}
            className="w-full p-4 text-left rounded-md border border-border hover:bg-accent/50 transition-colors"
          >
            <div className="font-medium">Start Fresh</div>
            <div className="text-sm text-muted-foreground mt-1">
              Clear all history and start a completely new session. Previous progress will be lost.
            </div>
          </button>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
