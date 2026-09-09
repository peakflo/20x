import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel
} from '@/components/ui/AlertDialog'
import { Button } from '@/components/ui/Button'

export interface CompleteAtSourceDialogProps {
  isOpen: boolean
  /** Title of the task being completed. */
  taskTitle: string
  /** Display name of the task source, e.g. "Notion — Engineering". */
  sourceName: string
  /** True while one of the two completion paths runs. */
  isBusy?: boolean
  /** Complete the task at the source, then in 20x. */
  onCompleteAtSource: () => void
  /** Complete the task in 20x only — the user updates the source. */
  onCompleteManually: () => void
  onCancel: () => void
}

/**
 * Asks how a task that came from a task source (Notion, Linear, YouTrack,
 * GitHub Issues, HubSpot) must be completed: at the source too, or in 20x only.
 * Workflo tasks never see this dialog — the server confirms their completion.
 */
export function CompleteAtSourceDialog({
  isOpen,
  taskTitle,
  sourceName,
  isBusy = false,
  onCompleteAtSource,
  onCompleteManually,
  onCancel
}: CompleteAtSourceDialogProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && !isBusy && onCancel()}>
      <AlertDialogContent data-testid="complete-at-source-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Complete in {sourceName}?</AlertDialogTitle>
          <AlertDialogDescription>
            "{taskTitle}" came from {sourceName}. 20x can mark it done there as well, or
            complete it here only and leave {sourceName} for you to update.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col-reverse sm:flex-row sm:justify-end">
          <AlertDialogCancel disabled={isBusy} onClick={onCancel}>
            Cancel
          </AlertDialogCancel>
          <Button
            variant="outline"
            disabled={isBusy}
            onClick={onCompleteManually}
            data-testid="complete-manually"
          >
            Only in 20x
          </Button>
          <Button
            disabled={isBusy}
            onClick={onCompleteAtSource}
            data-testid="complete-at-source"
          >
            Update {sourceName} too
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
