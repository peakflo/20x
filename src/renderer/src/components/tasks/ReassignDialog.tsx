import { useEffect } from 'react'
import { Users, Loader2 } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { useUserStore } from '@/stores/user-store'
import { cn } from '@/lib/utils'
import type { SourceUser } from '@/types'

const EMPTY_USERS: SourceUser[] = []

interface ReassignDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceId: string
  currentAssignee: string
  onReassign: (userIds: string[], displayName: string) => void
}

export function ReassignDialog({ open, onOpenChange, sourceId, currentAssignee, onReassign }: ReassignDialogProps) {
  const users = useUserStore((s) => s.cache.get(sourceId)?.users ?? EMPTY_USERS)
  const loading = useUserStore((s) => s.loadingSourceIds.has(sourceId))
  const isMe = useUserStore((s) => s.isMe)

  // Fetch users when dialog opens
  useEffect(() => {
    if (open) {
      useUserStore.getState().fetchUsers(sourceId)
    }
  }, [open, sourceId])

  const currentLower = currentAssignee.toLowerCase()
  const isCurrentUser = (u: { name: string; email: string }) =>
    u.name.toLowerCase() === currentLower || u.email.toLowerCase() === currentLower

  const handleSelect = (user: { id: string; name: string }) => {
    onReassign([user.id], user.name)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0">
        <div className="flex items-center gap-2 px-5 pt-5 pb-4">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Reassign to</span>
        </div>

        <div className="border-t border-border">
          {loading && users.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : users.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted-foreground text-center">
              No users found
            </div>
          ) : (
            users.map((user, i) => (
              <button
                key={user.id}
                onClick={() => handleSelect(user)}
                className={cn(
                  'flex w-full items-center justify-between px-5 py-3 text-sm hover:bg-accent cursor-pointer',
                  i < users.length - 1 && 'border-b border-border',
                  isCurrentUser(user) && 'bg-accent/50'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{user.name}</span>
                  {(isMe(user.email) || isMe(user.name)) && (
                    <span className="text-xs text-muted-foreground">(Me)</span>
                  )}
                </div>
                <span className="text-muted-foreground text-xs">{user.email}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
