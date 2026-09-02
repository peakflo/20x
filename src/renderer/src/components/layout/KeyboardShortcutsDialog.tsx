import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { KEYBOARD_SHORTCUT_GROUPS } from '@/lib/keyboard-shortcuts'

interface KeyboardShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {KEYBOARD_SHORTCUT_GROUPS.map((group) => (
            <section key={group.label}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </h3>
              <div className="divide-y divide-border/50 rounded-xl border border-border/60">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
                    <span>{shortcut.label}</span>
                    <span className="flex items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <kbd key={key} className="min-w-6 rounded-md border border-border bg-muted px-1.5 py-0.5 text-center text-[11px] text-muted-foreground shadow-xs">
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <p className="text-xs text-muted-foreground">
            Shortcuts pause while you type. Canvas drawing controls keep priority in Canvas.
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
