import { Sidebar } from './Sidebar'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { SkillWorkspace } from '@/components/skills/SkillWorkspace'
import { SettingsWorkspace } from '@/components/settings/SettingsWorkspace'
import { DashboardWorkspace } from '@/components/dashboard/DashboardWorkspace'
import { TaskForm, type TaskFormSubmitData } from '@/components/tasks/TaskForm'
import { DeleteConfirmDialog } from '@/components/tasks/DeleteConfirmDialog'
import { UpdateDialog } from '@/components/update/UpdateDialog'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle } from '@/components/ui/Dialog'
import { OrchestratorPanel } from '@/components/orchestrator/OrchestratorPanel'
import { OnboardingWizard, shouldShowOnboarding } from '@/components/onboarding/OnboardingWizard'
import { useTasks } from '@/hooks/use-tasks'
import { useUIStore } from '@/stores/ui-store'
import { useAgentStore } from '@/stores/agent-store'
import { useAgentAutoStart } from '@/hooks/use-agent-auto-start'
import { useOverdueNotifications } from '@/hooks/use-overdue-notifications'
import { attachmentApi, worktreeApi, settingsApi, updaterApi } from '@/lib/ipc-client'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { isOverdue, isSnoozed } from '@/lib/utils'
import { useEffect, useState, useCallback } from 'react'
import { TaskStatus, PluginActionId } from '@/types'
import type { FileAttachment } from '@/types'
import { MessageSquare, ExternalLink, LayoutDashboard, CheckSquare, Zap, Settings } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { SidebarView } from '@/stores/ui-store'
import logo20x from '@/assets/logos/20x.svg'

export function AppLayout() {
  const { tasks, allTasks, selectedTask, createTask, updateTask, deleteTask, selectTask } = useTasks()
  const { agents, sessions, fetchAgents, stopAndRemoveSessionForTask } = useAgentStore()
  const { executeAction } = useTaskSourceStore()
  const {
    sidebarView,
    setSidebarView,
    activeModal,
    editingTaskId,
    deletingTaskId,
    openCreateModal,
    openEditModal,
    openDeleteModal,
    openSettings,
    closeModal,
    dashboardPreviewTaskId,
    closeDashboardPreview
  } = useUIStore()

  // ── Update indicator state ──
  const [updateAvailableVersion, setUpdateAvailableVersion] = useState<string | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  useEffect(() => {
    fetchAgents()

    // Listen for update status events to show the yellow dot
    const cleanupStatus = updaterApi.onStatus((data) => {
      if (data.status === 'available' || data.status === 'downloading' || data.status === 'downloaded') {
        setUpdateAvailableVersion(data.version ?? null)
      }
    })

    // Listen for "Check for Updates" from the native application menu
    const cleanupMenu = updaterApi.onMenuCheckForUpdates(() => {
      setUpdateDialogOpen(true)
    })

    return () => {
      cleanupStatus()
      cleanupMenu()
    }
  }, [])

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || selectedTask : undefined
  const deletingTask = deletingTaskId ? tasks.find((t) => t.id === deletingTaskId) : undefined
  const dashboardPreviewTask = dashboardPreviewTaskId ? allTasks.find((t) => t.id === dashboardPreviewTaskId) : undefined

  const handleGoToFullView = useCallback((taskId: string) => {
    closeDashboardPreview()
    selectTask(taskId)
    setSidebarView('tasks')
  }, [closeDashboardPreview, selectTask, setSidebarView])

  const overdueCount = tasks.filter(
    (t) => isOverdue(t.due_date) && t.status !== TaskStatus.Completed && !isSnoozed(t.snoozed_until)
  ).length

  useOverdueNotifications(tasks)

  const [toast, setToast] = useState<{ message: string; isError?: boolean } | null>(null)
  const showToast = useCallback((message: string, isError?: boolean) => {
    setToast({ message, isError })
    setTimeout(() => setToast(null), isError ? 5000 : 3000)
  }, [])

  const [showOrchestrator, setShowOrchestrator] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)

  // Auto-open onboarding on first launch or major/minor version bumps
  useEffect(() => {
    Promise.all([
      settingsApi.get('setup_completed_version'),
      window.electronAPI?.app?.getVersion()
    ]).then(([completedVersion, currentVersion]) => {
      if (currentVersion && shouldShowOnboarding(completedVersion, currentVersion)) {
        setOnboardingOpen(true)
      }
    })
  }, [])

  const handleOnboardingChange = (open: boolean) => {
    setOnboardingOpen(open)
    if (!open) {
      window.electronAPI?.app?.getVersion().then((v) => {
        if (v) settingsApi.set('setup_completed_version', v)
      })
    }
  }

  // Initialize auto-start feature
  useAgentAutoStart({
    tasks: allTasks,
    agents,
    sessions,
    showToast
  })

  const NAV_ITEMS: { key: SidebarView; label: string; icon: typeof LayoutDashboard }[] = [
    { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { key: 'tasks', label: 'Tasks', icon: CheckSquare },
    { key: 'skills', label: 'Skills', icon: Zap }
  ]

  return (
    <>
      {/* ── Top bar: drag region with logo (left) + nav switcher (center) + actions (right) ── */}
      <div className="drag-region h-12 flex-shrink-0 flex items-center justify-center px-4 border-b border-border/50 windows-titlebar-pad">
        {/* Logo + update indicator — pinned left */}
        <div className="no-drag absolute left-4 flex items-center gap-2 macos-titlebar-pad">
          <div className="relative">
            <img src={logo20x} className="h-5 w-5" alt="20x" />
            {updateAvailableVersion && (
              <button
                onClick={() => setUpdateDialogOpen(true)}
                className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-background cursor-pointer animate-pulse"
                title={`Update available: v${updateAvailableVersion}`}
              />
            )}
          </div>
          <span className="text-sm font-semibold text-foreground">20x</span>
        </div>

        {/* View switcher — centered */}
        <div className="no-drag flex rounded-md border border-border bg-muted/30 p-0.5">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => {
                if (activeModal === 'settings') closeModal()
                setSidebarView(key)
              }}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                sidebarView === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>

        {/* Global actions — pinned right; windows-titlebar-actions offsets on Windows to avoid title bar overlay */}
        <div className="no-drag absolute right-4 flex items-center gap-1 windows-titlebar-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={openSettings}
            className="h-7 px-2"
            title="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={showOrchestrator ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setShowOrchestrator(!showOrchestrator)}
            className="h-7 px-2"
          >
            <MessageSquare className="h-3.5 w-3.5 mr-1" />
            <span className="text-xs">Mastermind</span>
          </Button>
        </div>
      </div>

      {/* ── Content area: optional sidebar + workspace ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar — only for tasks and skills views */}
        {sidebarView !== 'dashboard' && (
          <Sidebar
            tasks={tasks}
            selectedTaskId={selectedTask?.id || null}
            overdueCount={overdueCount}
            onSelectTask={selectTask}
            onCreateTask={openCreateModal}
          />
        )}

        {/* Workspace */}
        <main className="flex flex-col flex-1 min-w-0 overflow-hidden bg-background">
          <div className="flex-1 overflow-hidden relative">
            {/* Main workspace content */}
            {activeModal === 'settings' ? (
              <SettingsWorkspace />
            ) : sidebarView === 'dashboard' ? (
              <DashboardWorkspace />
            ) : sidebarView === 'skills' ? (
              <SkillWorkspace />
            ) : (
              <TaskWorkspace
              task={selectedTask}
              agents={agents}
              onEdit={() => {
                if (selectedTask) openEditModal(selectedTask.id)
              }}
              onDelete={() => {
                if (selectedTask) openDeleteModal(selectedTask.id)
              }}
              onUpdateAttachments={async (attachments: FileAttachment[]) => {
                if (selectedTask) {
                  await updateTask(selectedTask.id, { attachments })
                }
              }}
              onUpdateOutputFields={async (output_fields) => {
                if (selectedTask) {
                  await updateTask(selectedTask.id, { output_fields })
                }
              }}
              onCompleteTask={async () => {
                if (!selectedTask) return
                const taskTitle = selectedTask.title
                try {
                  if (selectedTask.source_id) {
                    const actionField = selectedTask.output_fields.find((f) => f.id === 'action')
                    const actionValue = actionField?.value ? String(actionField.value) : PluginActionId.Complete
                    const result = await executeAction(actionValue, selectedTask.id, selectedTask.source_id)
                    if (!result.success) {
                      showToast(result.error || 'Failed to complete task', true)
                      return
                    }
                  }
                  await updateTask(selectedTask.id, { status: TaskStatus.Completed })
                } catch (err) {
                  console.error('Failed to complete task:', err)
                  showToast('Failed to complete task', true)
                  return
                }
                // Select next active task
                const activeTasks = tasks.filter((t) => t.id !== selectedTask.id && t.status !== TaskStatus.Completed)
                selectTask(activeTasks.length > 0 ? activeTasks[0].id : null)
                showToast(`"${taskTitle}" completed`)
              }}
              onAssignAgent={async (taskId, agentId) => {
                await updateTask(taskId, { agent_id: agentId })
              }}
              onUpdateTask={async (taskId, data) => {
                await updateTask(taskId, data)
              }}
              onNavigateToTask={(taskId) => selectTask(taskId)}
            />
          )}

          {/* Orchestrator slide-in panel */}
          <div
            className={`absolute top-0 right-0 bottom-0 w-96 transition-transform duration-200 ${
              showOrchestrator ? 'translate-x-0' : 'translate-x-full'
            }`}
            style={{ zIndex: 10 }}
          >
            <OrchestratorPanel onClose={() => setShowOrchestrator(false)} />
          </div>
          </div>
        </main>
      </div>

      {/* Create Task Dialog */}
      <Dialog open={activeModal === 'create'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Task</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <TaskForm
              onSubmit={async (data) => {
                const formData = data as TaskFormSubmitData
                const pendingFiles = formData._pendingFiles
                delete formData._pendingFiles

                const newTask = await createTask(formData)
                if (newTask && pendingFiles?.length) {
                  const attachments: FileAttachment[] = []
                  for (const pf of pendingFiles) {
                    const a = await attachmentApi.save(newTask.id, pf.sourcePath)
                    attachments.push(a)
                  }
                  await updateTask(newTask.id, { attachments })
                }
                closeModal()
                if (newTask) selectTask(newTask.id)
              }}
              onCancel={closeModal}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Edit Task Dialog */}
      <Dialog open={activeModal === 'edit'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Task</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {editingTask && (
              <TaskForm
                task={editingTask}
                onSubmit={async (data) => {
                  await updateTask(editingTask.id, data)
                  closeModal()
                }}
                onCancel={closeModal}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <DeleteConfirmDialog
        isOpen={activeModal === 'delete'}
        taskTitle={deletingTask?.title || ''}
        onConfirm={async () => {
          if (deletingTaskId) {
            // Stop any active sessions for this task
            await stopAndRemoveSessionForTask(deletingTaskId)
            // Cleanup worktrees if task has repos
            if (deletingTask && deletingTask.repos?.length > 0) {
              try {
                const org = await settingsApi.get('github_org')
                if (org) {
                  await worktreeApi.cleanup(
                    deletingTaskId,
                    deletingTask.repos.map((r) => ({ fullName: r })),
                    org
                  )
                }
              } catch (error) {
                console.error('Failed to cleanup worktrees:', error)
              }
            }
            try {
              await deleteTask(deletingTaskId)
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err)
              showToast(`Failed to delete task: ${reason}`, true)
              return
            }
            // Close dashboard preview if the deleted task was being previewed
            if (dashboardPreviewTaskId === deletingTaskId) {
              closeDashboardPreview()
            }
            closeModal()
          }
        }}
        onCancel={closeModal}
      />

      {/* Onboarding Wizard — auto-opens on first launch or major/minor version bumps */}
      <OnboardingWizard open={onboardingOpen} onOpenChange={handleOnboardingChange} />

      {/* Dashboard task preview — reuses the full TaskWorkspace inside a dialog */}
      <Dialog open={!!dashboardPreviewTaskId} onOpenChange={(open) => { if (!open) closeDashboardPreview() }}>
        <DialogContent className="max-w-[90vw] h-[85vh] w-full">
          <DialogHeader className="flex-row items-center justify-between gap-4">
            <DialogTitle className="truncate">{dashboardPreviewTask?.title || 'Task'}</DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 mr-8"
              onClick={() => dashboardPreviewTaskId && handleGoToFullView(dashboardPreviewTaskId)}
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              <span className="text-xs">Go to Tasks view</span>
            </Button>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            {dashboardPreviewTask && (
              <TaskWorkspace
                task={dashboardPreviewTask}
                agents={agents}
                onEdit={() => {
                  if (dashboardPreviewTask) openEditModal(dashboardPreviewTask.id)
                }}
                onDelete={() => {
                  if (dashboardPreviewTask) openDeleteModal(dashboardPreviewTask.id)
                }}
                onUpdateAttachments={async (attachments: FileAttachment[]) => {
                  await updateTask(dashboardPreviewTask.id, { attachments })
                }}
                onUpdateOutputFields={async (output_fields) => {
                  await updateTask(dashboardPreviewTask.id, { output_fields })
                }}
                onCompleteTask={async () => {
                  const taskTitle = dashboardPreviewTask.title
                  try {
                    if (dashboardPreviewTask.source_id) {
                      const actionField = dashboardPreviewTask.output_fields.find((f) => f.id === 'action')
                      const actionValue = actionField?.value ? String(actionField.value) : PluginActionId.Complete
                      const result = await executeAction(actionValue, dashboardPreviewTask.id, dashboardPreviewTask.source_id)
                      if (!result.success) {
                        showToast(result.error || 'Failed to complete task', true)
                        return
                      }
                    }
                    await updateTask(dashboardPreviewTask.id, { status: TaskStatus.Completed })
                  } catch (err) {
                    console.error('Failed to complete task:', err)
                    showToast('Failed to complete task', true)
                    return
                  }
                  showToast(`"${taskTitle}" completed`)
                }}
                onAssignAgent={async (taskId, agentId) => {
                  await updateTask(taskId, { agent_id: agentId })
                }}
                onUpdateTask={async (taskId, data) => {
                  await updateTask(taskId, data)
                }}
                onNavigateToTask={(taskId) => {
                  closeDashboardPreview()
                  handleGoToFullView(taskId)
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Update dialog */}
      <UpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} />

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 border rounded-lg shadow-lg text-sm animate-in fade-in slide-in-from-bottom-2 ${toast.isError ? 'bg-destructive text-destructive-foreground' : 'bg-card'}`}>
          {toast.message}
        </div>
      )}
    </>
  )
}
