import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { githubApi } from '@/lib/ipc-client'

interface OrgPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (org: string) => void
}

export function OrgPickerDialog({ open, onOpenChange, onSelect }: OrgPickerDialogProps) {
  const [owners, setOwners] = useState<{ value: string; label: string }[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)

    Promise.all([githubApi.checkCli(), githubApi.fetchOrgs()])
      .then(([status, orgs]) => {
        const list: { value: string; label: string }[] = []
        if (status.username) {
          list.push({ value: status.username, label: `${status.username} (personal)` })
        }
        for (const org of orgs) {
          list.push({ value: org, label: org })
        }
        setOwners(list)
      })
      .catch(() => setOwners([]))
      .finally(() => setLoading(false))
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Select GitHub Organization</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Choose the organization or account to browse repositories from.
          </p>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : owners.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No organizations found.
            </p>
          ) : (
            <div className="space-y-1">
              {owners.map((o) => (
                <Button
                  key={o.value}
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => onSelect(o.value)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
