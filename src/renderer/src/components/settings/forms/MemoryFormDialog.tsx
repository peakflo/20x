import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Checkbox } from '@/components/ui/Checkbox'
import { MEMORY_KIND_OPTIONS, MEMORY_SCOPE_GLOBAL } from '@/types'
import type { MastermindMemory, CreateMemoryDTO, UpdateMemoryDTO, MemoryKind } from '@/types'

interface MemoryFormDialogProps {
  memory?: MastermindMemory
  open: boolean
  onClose: () => void
  onSubmit: (data: CreateMemoryDTO | UpdateMemoryDTO) => void
}

const MAX_CONTENT_CHARS = 1000

export function MemoryFormDialog({ memory, open, onClose, onSubmit }: MemoryFormDialogProps) {
  const [content, setContent] = useState(memory?.content ?? '')
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? 'preference')
  const [scope, setScope] = useState(memory?.scope ?? MEMORY_SCOPE_GLOBAL)
  const [importance, setImportance] = useState(memory?.importance ?? 3)
  const [pinned, setPinned] = useState(memory?.pinned ?? false)

  useEffect(() => {
    if (open) {
      setContent(memory?.content ?? '')
      setKind(memory?.kind ?? 'preference')
      setScope(memory?.scope ?? MEMORY_SCOPE_GLOBAL)
      setImportance(memory?.importance ?? 3)
      setPinned(memory?.pinned ?? false)
    }
  }, [open, memory?.id])

  const isValid = content.trim().length > 0 && content.trim().length <= MAX_CONTENT_CHARS

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return
    onSubmit({ content: content.trim(), kind, scope: scope.trim() || MEMORY_SCOPE_GLOBAL, importance, pinned })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{memory ? 'Edit memory' : 'New memory'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="memory-content">Content</Label>
              <Textarea
                id="memory-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Always use pnpm, never npm or yarn."
                rows={3}
                maxLength={MAX_CONTENT_CHARS}
                required
              />
              <p className="text-xs text-muted-foreground">
                {content.trim().length}/{MAX_CONTENT_CHARS} — a short, durable note, not a transcript. Never a secret or credential.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="memory-kind">Kind</Label>
                <select
                  id="memory-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as MemoryKind)}
                  className="w-full bg-transparent border border-border rounded px-2 py-1.5 text-sm capitalize"
                >
                  {MEMORY_KIND_OPTIONS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="memory-importance">Importance</Label>
                <select
                  id="memory-importance"
                  value={importance}
                  onChange={(e) => setImportance(Number(e.target.value))}
                  className="w-full bg-transparent border border-border rounded px-2 py-1.5 text-sm"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="memory-scope">Scope</Label>
              <Input
                id="memory-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="global"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                &apos;global&apos;, or &apos;project:&lt;id&gt;&apos; / &apos;repo:&lt;owner/name&gt;&apos; once Mastermind has project context.
              </p>
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer">
              <Checkbox checked={pinned} onCheckedChange={(checked) => setPinned(checked === true)} />
              <span className="text-sm">Pinned — always included first in what Mastermind remembers</span>
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!isValid}>
                {memory ? 'Save' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
