import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/AlertDialog'
import { Button } from '@/components/ui/Button'

interface IncompatibleSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStartFresh: () => void
  error?: string
}

export function IncompatibleSessionDialog({ open, onOpenChange, onStartFresh, error }: IncompatibleSessionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Incompatible Session</AlertDialogTitle>
          <AlertDialogDescription>
            {error || 'This session was created with a different coding agent backend and cannot be resumed.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="py-4">
          <div className="p-4 rounded-md bg-muted/50 border border-border">
            <div className="text-sm text-muted-foreground">
              The session ID format is incompatible with the current agent configuration.
              You'll need to start a new session to continue working on this task.
            </div>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            onClick={() => {
              onStartFresh()
              onOpenChange(false)
            }}
          >
            Start New Session
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
