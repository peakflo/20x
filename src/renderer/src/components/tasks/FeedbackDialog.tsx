import { useState, useEffect } from 'react'
import { Star } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { cn } from '@/lib/utils'

interface FeedbackDialogProps {
  open: boolean
  /**
   * Display name of the external source, when the task came from one. Set it to
   * show the completion choice; leave it undefined for a local task.
   */
  sourceName?: string | null
  onSubmit: (rating: number, comment: string, completeAtSource: boolean) => void
  onSkip: (completeAtSource: boolean) => void
  onCancel: () => void
}

export function FeedbackDialog({ open, sourceName, onSubmit, onSkip, onCancel }: FeedbackDialogProps) {
  const [rating, setRating] = useState(0)
  const [hoveredStar, setHoveredStar] = useState(0)
  const [comment, setComment] = useState('')
  // Defaults to closing the task at the source, which is what 20x did before
  // the choice existed.
  const [completeAtSource, setCompleteAtSource] = useState(true)

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setRating(0)
      setHoveredStar(0)
      setComment('')
      setCompleteAtSource(true)
    }
  }, [open])

  const handleSubmit = () => {
    if (rating > 0) onSubmit(rating, comment, completeAtSource)
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Session Feedback</DialogTitle>
          <DialogDescription>
            Rate this session to help the agent improve its skills
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="flex gap-1 justify-center">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                className="p-1 cursor-pointer"
                onMouseEnter={() => setHoveredStar(star)}
                onMouseLeave={() => setHoveredStar(0)}
                onClick={() => setRating(star)}
              >
                <Star
                  className={`h-7 w-7 transition-colors ${
                    star <= (hoveredStar || rating)
                      ? 'fill-[#f5b301] text-[#f5b301]'
                      : 'text-muted-foreground/40'
                  }`}
                />
              </button>
            ))}
          </div>
          <Textarea
            placeholder="Optional feedback..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
          />

          {sourceName && (
            <div className="flex flex-col gap-2 rounded-lg border border-border/50 p-3" data-testid="source-completion-choice">
              <span className="text-xs font-medium text-foreground">
                This task came from {sourceName}
              </span>
              <div className="flex gap-2">
                <ChoiceButton
                  selected={completeAtSource}
                  onClick={() => setCompleteAtSource(true)}
                  testId="choice-complete-at-source"
                  label={`Close it in ${sourceName}`}
                />
                <ChoiceButton
                  selected={!completeAtSource}
                  onClick={() => setCompleteAtSource(false)}
                  testId="choice-complete-manually"
                  label="I'll do it manually"
                />
              </div>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => onSkip(completeAtSource)}>
              Skip
            </Button>
            <Button size="sm" disabled={rating === 0} onClick={handleSubmit}>
              Submit Feedback
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function ChoiceButton({
  selected,
  onClick,
  label,
  testId
}: {
  selected: boolean
  onClick: () => void
  label: string
  testId: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex-1 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors',
        selected
          ? 'border-ring bg-accent/60 text-foreground'
          : 'border-border/50 text-muted-foreground hover:bg-accent/30'
      )}
    >
      {label}
    </button>
  )
}
