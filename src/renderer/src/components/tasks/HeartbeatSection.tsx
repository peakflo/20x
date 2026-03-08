import { useState, useEffect, useCallback } from 'react'
import { HeartPulse } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Textarea } from '@/components/ui/Textarea'
import { Markdown } from '@/components/ui/Markdown'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle } from '@/components/ui/Dialog'
import type { WorkfloTask } from '@/types'
import type { HeartbeatStatusResult } from '@/types/electron'
import { HeartbeatStatus } from '@/types'
import { formatRelativeDate } from '@/lib/utils'

interface HeartbeatLog {
  id: string
  task_id: string
  status: string
  summary: string | null
  session_id: string | null
  created_at: string
}

interface HeartbeatSectionProps {
  task: WorkfloTask
  onTaskUpdated?: () => void
}

/**
 * Heartbeat property row — renders inside the task properties grid.
 * Shows heartbeat status + content preview. Clicking opens an edit modal.
 */
export function HeartbeatSection({ task, onTaskUpdated }: HeartbeatSectionProps) {
  const [status, setStatus] = useState<HeartbeatStatusResult | null>(null)
  const [heartbeatContent, setHeartbeatContent] = useState<string | null>(null)
  const [logs, setLogs] = useState<HeartbeatLog[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const result = await window.electronAPI.heartbeat.getStatus(task.id)
      setStatus(result)
    } catch { /* noop */ }
  }, [task.id])

  const fetchContent = useCallback(async () => {
    try {
      const content = await window.electronAPI.heartbeat.readFile(task.id)
      setHeartbeatContent(content)
    } catch { /* noop */ }
  }, [task.id])

  const fetchLogs = useCallback(async () => {
    try {
      const result = await window.electronAPI.heartbeat.getLogs(task.id, 5) as HeartbeatLog[]
      setLogs(result)
    } catch { /* noop */ }
  }, [task.id])

  useEffect(() => {
    fetchStatus()
    fetchContent()
    fetchLogs()
  }, [fetchStatus, fetchContent, fetchLogs])

  // Listen for heartbeat events
  useEffect(() => {
    const unsubAlert = window.electronAPI.onHeartbeatAlert((event: unknown) => {
      const alert = event as { taskId: string }
      if (alert.taskId === task.id) {
        fetchStatus()
        fetchContent()
        fetchLogs()
      }
    })
    const unsubDisabled = window.electronAPI.onHeartbeatDisabled((event: unknown) => {
      const data = event as { taskId: string }
      if (data.taskId === task.id) {
        fetchStatus()
      }
    })
    return () => { unsubAlert(); unsubDisabled() }
  }, [task.id, fetchStatus, fetchContent, fetchLogs])

  // Don't render for tasks that aren't ready_for_review and don't have heartbeat
  if (!status?.hasHeartbeatFile && !status?.enabled && task.status !== 'ready_for_review') {
    return null
  }

  const handleOpenModal = () => {
    setEditDraft(heartbeatContent || '# Heartbeat Checks\n- [ ] ')
    fetchLogs()
    setModalOpen(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.electronAPI.heartbeat.writeFile(task.id, editDraft)
      setHeartbeatContent(editDraft.trim() || null)
      await fetchStatus()
      onTaskUpdated?.()
      setModalOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async () => {
    if (status?.enabled) {
      await window.electronAPI.heartbeat.disable(task.id)
    } else {
      await window.electronAPI.heartbeat.enable(task.id)
    }
    await fetchStatus()
    onTaskUpdated?.()
    setModalOpen(false)
  }

  const handleRunNow = async () => {
    setModalOpen(false)
    const result = await window.electronAPI.heartbeat.runNow(task.id)
    if (result === 'sent') {
      // Agent is now working — transcript will update visibly
      onTaskUpdated?.()
    } else if (result === 'no_file') {
      alert('No heartbeat.md file found. Save instructions first.')
    } else if (result === 'no_agent') {
      alert('No agent assigned to this task.')
    } else {
      alert('Failed to run heartbeat check.')
    }
  }

  const handleIntervalChange = async (minutes: number) => {
    await window.electronAPI.heartbeat.updateInterval(task.id, minutes)
    await fetchStatus()
    onTaskUpdated?.()
  }

  const lastLog = logs[0]
  const statusBadge = !status?.enabled
    ? <Badge variant="default">Off</Badge>
    : lastLog?.status === HeartbeatStatus.AttentionNeeded
    ? <Badge variant="yellow">Attention</Badge>
    : lastLog?.status === HeartbeatStatus.Error
    ? <Badge variant="red">Error</Badge>
    : <Badge variant="green">OK</Badge>

  return (
    <>
      {/* Property row — label */}
      <span className="text-muted-foreground flex items-center gap-2">
        <HeartPulse className={`h-3.5 w-3.5 ${status?.enabled ? 'text-rose-500' : ''}`} /> Heartbeat
      </span>

      {/* Property row — value: show full markdown instructions, click to edit */}
      <div
        className="cursor-pointer hover:bg-muted/50 rounded -mx-1 px-1 transition-colors"
        onClick={handleOpenModal}
        title="Click to edit heartbeat instructions"
      >
        <div className="flex items-center gap-2 mb-1">
          {statusBadge}
          {status?.nextCheckAt && status?.enabled && (
            <span className="text-[10px] text-muted-foreground/60 shrink-0">
              next {formatRelativeDate(status.nextCheckAt)}
            </span>
          )}
        </div>
        {heartbeatContent ? (
          <div className="text-xs">
            <Markdown size="xs">{heartbeatContent}</Markdown>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/50">Click to set up instructions</span>
        )}
      </div>

      {/* Edit modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-rose-400" />
              Heartbeat Instructions
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {/* Instructions editor */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">
                What should the agent check periodically?
              </label>
              <Textarea
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                rows={6}
                placeholder={'# Heartbeat Checks\n- [ ] Check if PR has new review comments\n- [ ] Verify CI pipeline passed'}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>

            {/* Preview */}
            {editDraft.trim() && (
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">Preview</label>
                <div className="rounded-md border p-3 max-h-40 overflow-y-auto">
                  <Markdown size="xs">{editDraft}</Markdown>
                </div>
              </div>
            )}

            {/* Controls */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={status?.enabled ? 'destructive' : 'default'}
                  onClick={handleToggle}
                  disabled={!heartbeatContent && !editDraft.trim()}
                >
                  {status?.enabled ? 'Disable' : 'Enable'}
                </Button>
                {status?.enabled && (
                  <Button size="sm" variant="outline" onClick={handleRunNow}>
                    Run Now
                  </Button>
                )}
                {status?.enabled && (
                  <select
                    value={status.intervalMinutes ?? 30}
                    onChange={(e) => handleIntervalChange(parseInt(e.target.value))}
                    className="bg-transparent border rounded px-2 py-1 text-xs"
                  >
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={60}>1 hour</option>
                    <option value={120}>2 hours</option>
                    <option value={240}>4 hours</option>
                  </select>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>

            {/* Recent checks */}
            {logs.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">Recent Checks</label>
                <div className="space-y-1">
                  {logs.map((log) => (
                    <div key={log.id} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2 py-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant={
                          log.status === HeartbeatStatus.Ok ? 'green'
                          : log.status === HeartbeatStatus.AttentionNeeded ? 'yellow'
                          : 'red'
                        }>
                          {log.status === HeartbeatStatus.Ok ? 'OK'
                          : log.status === HeartbeatStatus.AttentionNeeded ? 'Attention'
                          : 'Error'}
                        </Badge>
                        {log.summary && log.status !== HeartbeatStatus.Ok && (
                          <span className="text-muted-foreground truncate">{log.summary}</span>
                        )}
                      </div>
                      <span className="text-muted-foreground/60 shrink-0 ml-2">
                        {formatRelativeDate(log.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}
