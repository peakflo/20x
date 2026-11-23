import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, X } from 'lucide-react'
import { SettingsSection } from '../SettingsSection'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/AlertDialog'
import { MachinesTable } from '@/components/machines/MachinesTable'
import { useMachinesStore } from '@/stores/machines-store'
import { useConnectComputerStore } from '@/stores/connect-computer-store'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { buildUninstallCommand, type MachineRow } from '@shared/enterprise-runners'

/** Gentle polling: slow when idle, faster while something is changing. */
const POLL_IDLE_MS = 30_000
const POLL_ACTIVE_MS = 8_000

export function MachinesSettings() {
  const { snapshot, loadState, error, busyIds, actionError, removed, refresh, rename, remove, update, updateAll, dismissRemoved, dismissActionError } =
    useMachinesStore()
  const isAuthenticated = useEnterpriseStore((s) => s.isAuthenticated)
  const openConnect = useConnectComputerStore((s) => s.openConnect)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)

  const [renaming, setRenaming] = useState<MachineRow | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [removing, setRemoving] = useState<MachineRow | null>(null)

  const machines = snapshot?.machines ?? []
  const changing = machines.some((m) => m.versionState.updating || m.versionState.kind === 'refused')

  // Load now, then poll quietly while visible.
  useEffect(() => {
    if (!isAuthenticated) return
    void refresh()
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refresh({ quiet: true })
    }, changing ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    const unsubscribe = window.electronAPI?.enterpriseRunners?.onMachinesChanged?.(() => void refresh({ quiet: true }))
    return () => {
      clearInterval(interval)
      unsubscribe?.()
    }
  }, [isAuthenticated, changing, refresh])

  const startRename = useCallback((machine: MachineRow) => {
    setRenaming(machine)
    setRenameValue(machine.name)
  }, [])

  const state = !isAuthenticated ? 'error' : loadState
  const viewError = !isAuthenticated
    ? { kind: 'not_signed_in' as const, message: 'Sign in to Peakflo Enterprise to manage machines.' }
    : error

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Machines"
        description="Computers and shared runners that run agents from Spaces and your phone."
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">macOS and Linux only.</p>
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => void refresh()}
              disabled={!isAuthenticated || loadState === 'loading'}
              aria-label="Refresh machines"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => openConnect()} disabled={!isAuthenticated}>
              <Plus className="h-4 w-4" /> Connect this computer
            </Button>
          </div>
        </div>

        {actionError && (
          <div role="alert" className="flex items-start justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm">
            <span>{actionError}</span>
            <button aria-label="Dismiss" onClick={dismissActionError}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {removed && (
          <div className="space-y-2 rounded-lg border border-border/60 p-3 text-sm" data-testid="removed-notice">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="font-medium">{removed.name}</span> was removed. The background service keeps running on that
                computer until you uninstall it there:
              </div>
              <button aria-label="Dismiss" onClick={dismissRemoved}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <code className="block select-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{removed.uninstallCommand}</code>
          </div>
        )}

        <MachinesTable
          state={state}
          error={viewError}
          machines={machines}
          pinnedVersion={snapshot?.pinnedVersion ?? null}
          busyIds={busyIds}
          onConnect={() => openConnect()}
          onRetry={() => void refresh()}
          onSignIn={() => setSettingsTab(SettingsTab.ENTERPRISE)}
          onRename={startRename}
          onRemove={setRemoving}
          onUpdate={(m) => void update(m.id)}
          onReconnect={(m) => openConnect({ replacesRunnerId: m.id, replacesName: m.name })}
          onUpdateAll={() => void updateAll()}
        />
      </SettingsSection>

      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename machine</DialogTitle>
            <DialogDescription>Shown to you in “Run on”.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form
              id="rename-machine-form"
              onSubmit={(e) => {
                e.preventDefault()
                const target = renaming
                if (!target || !renameValue.trim()) return
                void rename(target.id, renameValue.trim()).then((ok) => { if (ok) setRenaming(null) })
              }}
              className="space-y-1.5"
            >
              <Label htmlFor="rename-machine-input">Name</Label>
              <Input id="rename-machine-input" autoFocus maxLength={255} value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
            </form>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="submit" form="rename-machine-form" disabled={!renameValue.trim() || renameValue.trim() === renaming?.name}>
                Save
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>It will stop appearing in “Run on”. To use it again, connect it again.</p>
                {(removing?.activeSessions ?? 0) > 0 && (
                  <p>{removing?.activeSessions} running session{removing?.activeSessions === 1 ? '' : 's'} will stop.</p>
                )}
                {(removing?.pinnedAgents.length ?? 0) > 0 && (
                  <p>
                    These agents stay, but cannot run until you reconnect a machine or choose another runner in the agent editor:{' '}
                    <span className="font-medium">{removing?.pinnedAgents.map((a) => a.name).join(', ')}</span>
                  </p>
                )}
                <p>The background service keeps running on that machine until you uninstall it there:</p>
                <code className="block select-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  {buildUninstallCommand(snapshot?.pinnedVersion ?? removing?.version ?? null)}
                </code>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = removing
                setRemoving(null)
                if (target) void remove(target.id)
              }}
            >
              Remove machine
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
