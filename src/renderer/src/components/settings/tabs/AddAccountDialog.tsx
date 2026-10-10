import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { harnessInstanceApi } from '@/lib/ipc-client'
import { suggestHarnessInstanceHome, type HarnessInstanceView, type HarnessType } from '@shared/harness-instances'

const HARNESS_OPTIONS: Array<{ value: HarnessType; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' }
]

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful create, with the newly created instance. */
  onCreated: (instance: HarnessInstanceView) => void
}

/**
 * Modal form for Settings → Harnesses → Accounts' "Add account" button. Replaces
 * the always-visible inline form: the fields only exist while this is open.
 */
export function AddAccountDialog({ open, onOpenChange, onCreated }: AddAccountDialogProps) {
  const [harness, setHarness] = useState<HarnessType>('codex')
  const [name, setName] = useState('')
  const [homePath, setHomePath] = useState(() => suggestHarnessInstanceHome('codex', ''))
  const [homeEdited, setHomeEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset to a clean slate every time the dialog opens, including after a
  // prior successful add (so the form is ready for the next one).
  useEffect(() => {
    if (open) {
      setHarness('codex')
      setName('')
      setHomePath(suggestHarnessInstanceHome('codex', ''))
      setHomeEdited(false)
      setSaving(false)
      setError(null)
    }
  }, [open])

  // Keep the home-folder suggestion in sync with harness + name, until the
  // user types into that field by hand.
  useEffect(() => {
    if (!homeEdited) {
      setHomePath(suggestHarnessInstanceHome(harness, name))
    }
  }, [harness, name, homeEdited])

  const canSubmit = name.trim() !== '' && homePath.trim() !== '' && !saving

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const created = await harnessInstanceApi.create({
        harness_type: harness,
        label: name.trim(),
        home_path: homePath.trim()
      })
      onOpenChange(false)
      onCreated(created)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onOpenChange(false) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
          <DialogDescription>
            Add another Claude Code or Codex subscription login. Agents pick it in their harness dropdown.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-account-harness">Harness</Label>
              <select
                id="add-account-harness"
                value={harness}
                onChange={(e) => setHarness(e.target.value as HarnessType)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
              >
                {HARNESS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-account-name">Name</Label>
              <Input
                id="add-account-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Work"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-account-home">Home folder</Label>
              <Input
                id="add-account-home"
                value={homePath}
                onChange={(e) => { setHomePath(e.target.value); setHomeEdited(true) }}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {saving ? 'Adding…' : 'Add account'}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
