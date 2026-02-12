import { useState } from 'react'
import { Clock } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { getSnoozeOptions } from '@/lib/snooze-options'

interface SnoozeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSnooze: (isoString: string) => void
}

export function SnoozeDialog({ open, onOpenChange, onSnooze }: SnoozeDialogProps) {
  const [customDate, setCustomDate] = useState('')
  const options = getSnoozeOptions()

  const handleCustomSubmit = () => {
    if (!customDate) return
    onSnooze(new Date(customDate).toISOString())
    setCustomDate('')
  }

  const handlePreset = (value: string) => {
    onSnooze(value)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0">
        <div className="flex items-center gap-2 px-5 pt-5 pb-4">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Remind me</span>
        </div>

        <div className="border-t border-border" />

        <div className="px-5 py-3">
          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomSubmit()}
              className="flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
            />
            {customDate && (
              <button
                onClick={handleCustomSubmit}
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Set
              </button>
            )}
          </div>
        </div>

        <div className="border-t border-border">
          {options.map((option, i) => (
            <button
              key={option.label}
              onClick={() => handlePreset(option.value)}
              className={`flex w-full items-center justify-between px-5 py-3 text-sm hover:bg-accent cursor-pointer ${
                i < options.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <span className="text-foreground">{option.label}</span>
              <span className="text-muted-foreground font-mono text-xs">{option.description}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
