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
  /** Display name of the task source, e.g. "Linear — Engineering". */
  sourceName: string
  /** True while one of the two completion paths runs. */
  isBusy?: boolean
  /** Complete the task in the external source, then locally. */
  onCompleteAtSource: () => void
  /** Complete the task locally only — the user updates the source. */
  onCompleteManually: () => void
  onCancel: () => void
}

/**
 * Asks the user how a task that came from an external source must be completed:
 * in the source system, or locally only.
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
            "{taskTitle}" came from {sourceName}. 20x can close it there for you, or you can
            mark it complete here only and update {sourceName} yourself.
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
            I'll do it manually
          </Button>
          <Button
            disabled={isBusy}
            onClick={onCompleteAtSource}
            data-testid="complete-at-source"
          >
            Complete at source
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
