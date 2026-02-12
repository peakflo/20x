import { useState, useMemo } from 'react'
import { UserRoundPen } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useUserStore } from '@/stores/user-store'
import { ReassignDialog } from './ReassignDialog'
import type { SourceUser } from '@/types'

const EMPTY_USERS: SourceUser[] = []

interface AssigneeSelectProps {
  assignee: string
  sourceId: string | null
  taskId: string
  onReassign: (userIds: string[], displayName: string) => void
}

export function AssigneeSelect({ assignee, sourceId, onReassign }: AssigneeSelectProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const users = useUserStore((s) => (sourceId ? s.cache.get(sourceId)?.users : undefined) ?? EMPTY_USERS)
  const isMe = useUserStore((s) => s.isMe)

  const displayName = useMemo(() => {
    if (!assignee) return 'Unassigned'
    const lower = assignee.toLowerCase()
    const match = users.find(
      (u) => u.name.toLowerCase() === lower || u.email.toLowerCase() === lower
    )
    const name = match?.name ?? assignee
    const me = match
      ? isMe(match.email) || isMe(match.name)
      : isMe(assignee)
    return me ? `${name} (Me)` : name
  }, [assignee, users, isMe])

  return (
    <div className="flex items-center gap-2">
      <span>{displayName}</span>
      {sourceId && (
        <>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setDialogOpen(true)}>
            <UserRoundPen className="h-3.5 w-3.5" />
          </Button>
          <ReassignDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            sourceId={sourceId}
            currentAssignee={assignee}
            onReassign={onReassign}
          />
        </>
      )}
    </div>
  )
}
