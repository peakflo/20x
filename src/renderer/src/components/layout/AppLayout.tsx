import { useEffect, useState, useCallback, useMemo, lazy, Suspense } from 'react'
import { Sidebar } from './Sidebar'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { InfiniteCanvas } from '@/components/canvas/InfiniteCanvas'
import { TaskForm, type TaskFormSubmitData } from '@/components/tasks/TaskForm'
import { DeleteConfirmDialog } from '@/components/tasks/DeleteConfirmDialog'
import { UpdateDialog } from '@/components/update/UpdateDialog'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle } from '@/components/ui/Dialog'
import { OnboardingWizard, shouldShowOnboarding } from '@/components/onboarding/OnboardingWizard'
import { ProgressToastStack } from '@/components/ui/ProgressToastStack'

// Lazy-load heavy workspace components — only imported when their view is active.
// This reduces the initial bundle size and speeds up first render significantly.
const SkillWorkspace = lazy(() => import('@/components/skills/SkillWorkspace').then(m => ({ default: m.SkillWorkspace })))
const SettingsWorkspace = lazy(() => import('@/components/settings/SettingsWorkspace').then(m => ({ default: m.SettingsWorkspace })))
const DashboardWorkspace = lazy(() => import('@/components/dashboard/DashboardWorkspace').then(m => ({ default: m.DashboardWorkspace })))
const OrchestratorPanel = lazy(() => import('@/components/orchestrator/OrchestratorPanel').then(m => ({ default: m.OrchestratorPanel })))
import { useTasks } from '@/hooks/use-tasks'
import { useUIStore } from '@/stores/ui-store'
import { useAgentStore } from '@/stores/agent-store'
import { useAgentAutoStart } from '@/hooks/use-agent-auto-start'
import { useOverdueNotifications } from '@/hooks/use-overdue-notifications'
import { attachmentApi, worktreeApi, settingsApi, updaterApi } from '@/lib/ipc-client'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { isOverdue, isSnoozed } from '@/lib/utils'
import { TaskStatus, PluginActionId } from '@/types'
import type { FileAttachment } from '@/types'
import { MessageSquare, ExternalLink, LayoutDashboard, CheckSquare, Zap, Settings, Layers, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ThemeToggle } from './ThemeToggle'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import type { SidebarView } from '@/stores/ui-store'
import logo20x from '@/assets/logos/20x.svg'

const isWindows = navigator.platform.toLowerCase().startsWith('win') || navigator.userAgent.includes('Windows')
const isMac = navigator.platform.toLowerCase().includes('mac')
const modKey = isMac ? '⌘' : 'Ctrl'
const WINDOWS_TITLEBAR_ACTION_RIGHT = 168

const NAV_ITEMS: { key: SidebarView; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'canvas', label: 'Canvas', icon: Layers },
  { key: 'tasks', label: 'Tasks', icon: CheckSquare },
  { key: 'skills', label: 'Skills', icon: Zap }
]

export function AppLayout() {
  const { tasks, allTasks, selectedTask, createTask, updateTask, deleteTask, selectTask } = useTasks()
  // Use individual selectors to prevent re-renders from unrelated agent store changes (e.g. session messages)
  const agents = useAgentStore((s) => s.agents)
  const fetchAgents = useAgentStore((s) => s.fetchAgents)
  const stopAndRemoveSessionForTask = useAgentStore((s) => s.stopAndRemoveSessionForTask)
  const executeAction = useTaskSourceStore((s) => s.executeAction)
  // Use individual selectors for UI store to prevent full-tree re-renders
  const sidebarView = useUIStore((s) => s.sidebarView)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const editingTaskId = useUIStore((s) => s.editingTaskId)
  const deletingTaskId = useUIStore((s) => s.deletingTaskId)
  const openCreateModal = useUIStore((s) => s.openCreateModal)
  const openEditModal = useUIStore((s) => s.openEditModal)
  const openDeleteModal = useUIStore((s) => s.openDeleteModal)
  const openSettings = useUIStore((s) => s.openSettings)
  const closeModal = useUIStore((s) => s.closeModal)
  const setCanvasPendingTaskId = useUIStore((s) => s.setCanvasPendingTaskId)
  const clearCanvasPendingTask = useUIStore((s) => s.clearCanvasPendingTask)
  const dashboardPreviewTaskId = useUIStore((s) => s.dashboardPreviewTaskId)
  const closeDashboardPreview = useUIStore((s) => s.closeDashboardPreview)
  const canvasPendingTaskId = useUIStore((s) => s.canvasPendingTaskId)
  const showOrchestrator = useUIStore((s) => s.showOrchestrator)
  const setShowOrchestrator = useUIStore((s) => s.setShowOrchestrator)
  const toggleOrchestrator = useUIStore((s) => s.toggleOrchestrator)
  const createTaskPrefill = useUIStore((s) => s.createTaskPrefill)
  const clearCreateTaskPrefill = useUIStore((s) => s.clearCreateTaskPrefill)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed)

  // ── Command palette ──
  const [cmdOpen, setCmdOpen] = useState(false)

  // ── Update indicator state ──
  const [updateAvailableVersion, setUpdateAvailableVersion] = useState<string | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  useEffect(() => {
    fetchAgents()

    // Listen for update status events to show the yellow dot
    const cleanupStatus = updaterApi.onStatus((data) => {
      if (data.status === 'available' || data.status === 'downloading' || data.status === 'downloaded') {
        setUpdateAvailableVersion(data.version ?? null)
      } else if (data.status === 'up-to-date') {
        setUpdateAvailableVersion(null)
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

  const editingTask = useMemo(
    () => editingTaskId ? allTasks.find((t) => t.id === editingTaskId) : undefined,
    [editingTaskId, allTasks]
  )
  const deletingTask = useMemo(
    () => deletingTaskId ? allTasks.find((t) => t.id === deletingTaskId) : undefined,
    [deletingTaskId, allTasks]
  )
  const dashboardPreviewTask = useMemo(
    () => dashboardPreviewTaskId ? allTasks.find((t) => t.id === dashboardPreviewTaskId) : undefined,
    [dashboardPreviewTaskId, allTasks]
  )

  const handleGoToFullView = useCallback((taskId: string) => {
    closeDashboardPreview()
    selectTask(taskId)
    setSidebarView('tasks')
  }, [closeDashboardPreview, selectTask, setSidebarView])

  const overdueCount = useMemo(
    () => tasks.filter(
      (t) => isOverdue(t.due_date) && t.status !== TaskStatus.Completed && !isSnoozed(t.snoozed_until)
    ).length,
    [tasks]
  )

  useOverdueNotifications(tasks)

  const [toast, setToast] = useState<{ message: string; isError?: boolean } | null>(null)
  const showToast = useCallback((message: string, isError?: boolean) => {
    setToast({ message, isError })
    setTimeout(() => setToast(null), isError ? 5000 : 3000)
  }, [])

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

  // Initialize auto-start feature (sessions read non-reactively via getState() inside the hook)
  useAgentAutoStart({
    tasks: allTasks,
    agents,
    showToast
  })

  // ── Track zoom factor so macOS traffic-light margin stays constant in physical pixels ──
  useEffect(() => {
    const update = () => {
      // outerWidth is in device-independent screen px (stable); innerWidth shrinks/grows with zoom
      const factor = window.outerWidth && window.innerWidth
        ? window.outerWidth / window.innerWidth
        : 1
      if (factor > 0) {
        document.documentElement.style.setProperty('--zoom-factor', String(factor))
      }
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // ── Global keyboard shortcuts: ⌘/Ctrl+K command palette, ⌘/Ctrl+1–4 view switch ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen((v) => !v)
        return
      }
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= NAV_ITEMS.length) {
        e.preventDefault()
        if (activeModal === 'settings') closeModal()
        setSidebarView(NAV_ITEMS[n - 1].key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeModal, closeModal, setSidebarView])

  return (
    <>
      {/* ── Top bar: drag region with logo (left) + nav switcher (center) + actions (right) ── */}
      <div className="drag-region bg-background h-8 flex-shrink-0 flex items-center justify-center px-3 windows-titlebar-pad">
        {/* Logo + wordmark + update indicator — pinned left. The white logo mark
            always sits on a brand-gradient tile, so it stays visible in both themes. */}
        <div className="no-drag absolute left-3 flex items-center gap-1.5 macos-titlebar-pad">
          <div className="relative grid h-5 w-5 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/75 shadow-sm ring-1 ring-black/5">
            <img src={logo20x} className="h-3 w-3" alt="20x" />
            {updateAvailableVersion && (
              <button
                onClick={() => setUpdateDialogOpen(true)}
                className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-[var(--chrome-solid)] cursor-pointer animate-pulse"
                title={`Update available: v${updateAvailableVersion}`}
              />
            )}
          </div>
          <span className="text-[12px] font-semibold tracking-tight text-foreground">20x</span>

          {/* Sidebar collapse toggle — only for views that have a contextual sidebar */}
          {(sidebarView === 'tasks' || sidebarView === 'skills') && activeModal !== 'settings' && (
            <button
              onClick={toggleSidebarCollapsed}
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              className="ml-0.5 grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
            </button>
          )}

          {/* Breadcrumb — current section */}
          {(() => {
            const item = activeModal === 'settings'
              ? { label: 'Settings', icon: Settings }
              : NAV_ITEMS.find((n) => n.key === sidebarView)
            if (!item) return null
            const Icon = item.icon
            return (
              <div className="flex items-center gap-1.5">
                <span className="text-border/80 text-xs">/</span>
                <Icon className="h-3 w-3 text-muted-foreground" />
                <span className="text-[12px] font-medium text-foreground/90">{item.label}</span>
              </div>
            )
          })()}
        </div>

        {/* Centered command/search launcher (⌘K) */}
        <button
          onClick={() => setCmdOpen(true)}
          title="Search or run a command"
          className="no-drag flex h-7 w-[230px] max-w-[34vw] items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-2.5 text-[11px] text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
        >
          <Search className="h-3 w-3 shrink-0" />
          <span className="flex-1 truncate text-left">Search or run a command…</span>
          <kbd className="shrink-0 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px]">{modKey}K</kbd>
        </button>

        {/* Global actions — pinned right; offset on Windows to avoid native window controls. */}
        <div
          className="no-drag absolute right-4 flex items-center gap-1 windows-titlebar-actions"
          style={isWindows ? { right: WINDOWS_TITLEBAR_ACTION_RIGHT } : undefined}
        >
          <ThemeToggle />
          <button
            onClick={openSettings}
            title="Settings"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1 h-3.5 w-px bg-border/70" />
          <Button
            variant={showOrchestrator ? 'default' : 'secondary'}
            size="sm"
            onClick={toggleOrchestrator}
            className="h-7 px-2.5"
          >
            <MessageSquare className="h-3 w-3" />
            <span className="text-[11px]">Mastermind</span>
          </Button>
        </div>
      </div>

      {/* ── Content area: left rail + optional sidebar + workspace + orchestrator ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Primary navigation — slim vertical icon rail */}
        <nav className="no-drag flex w-10 flex-shrink-0 flex-col items-center gap-0.5 bg-background py-1.5">
          {NAV_ITEMS.map(({ key, label, icon: Icon }, i) => {
            const active = sidebarView === key && activeModal !== 'settings'
            return (
              <button
                key={key}
                onClick={() => {
                  if (activeModal === 'settings') closeModal()
                  setSidebarView(key)
                }}
                aria-label={label}
                className={`group relative grid h-8 w-8 place-items-center rounded-lg transition-all duration-150 cursor-pointer ${
                  active
                    ? 'bg-primary/12 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-3.5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <Icon className="h-4 w-4" />
                {/* Hover flyout label + shortcut */}
                <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 flex -translate-y-1/2 translate-x-[-4px] items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-popover px-2 py-1 text-xs font-medium text-foreground opacity-0 shadow-pop transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100">
                  {label}
                  <kbd className="rounded border border-border bg-muted px-1 text-[10px] text-muted-foreground">{modKey}{i + 1}</kbd>
                </span>
              </button>
            )
          })}
        </nav>

        {/* Sidebar — only for tasks and skills views, and when not collapsed */}
        {sidebarView !== 'dashboard' && sidebarView !== 'canvas' && !sidebarCollapsed && (
          <Sidebar
            tasks={tasks}
            selectedTaskId={selectedTask?.id || null}
            overdueCount={overdueCount}
            onSelectTask={selectTask}
            onCreateTask={openCreateModal}
          />
        )}

        {/* Workspace — floats as a rounded card, shrinks when orchestrator is open */}
        <main className="flex flex-col flex-1 min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-card m-2 transition-all duration-200">
          <div className="flex-1 h-0 overflow-hidden relative">
            {/* Canvas — always mounted so iframes/terminals survive navigation */}
            <div
              className="absolute inset-0"
              style={{ visibility: sidebarView === 'canvas' && activeModal !== 'settings' ? 'visible' : 'hidden' }}
            >
              <InfiniteCanvas />
            </div>

            {/* Other workspace content — conditionally rendered */}
            {activeModal === 'settings' ? (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading...</div>}>
                <SettingsWorkspace />
              </Suspense>
            ) : sidebarView === 'dashboard' ? (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading...</div>}>
                <DashboardWorkspace />
              </Suspense>
            ) : sidebarView === 'skills' ? (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading...</div>}>
                <SkillWorkspace />
              </Suspense>
            ) : sidebarView !== 'canvas' ? (
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
          ) : null}
          </div>
        </main>

        {/* Mastermind drawer — sits beside the workspace, shifts main content left */}
        <div
          className={`flex-shrink-0 transition-all duration-200 ease-in-out overflow-hidden ${
            showOrchestrator ? 'w-[340px]' : 'w-0'
          }`}
        >
          <div className="w-[340px] h-full">
            <Suspense fallback={null}>
              <OrchestratorPanel onClose={() => setShowOrchestrator(false)} />
            </Suspense>
          </div>
        </div>
      </div>

      {/* Bottom status bar — live agent/task counts + version */}
      <StatusBar />

      {/* Create Task Dialog — dismiss on outside click */}
      <Dialog open={activeModal === 'create'} onOpenChange={(open) => { if (!open) { closeModal(); clearCreateTaskPrefill() } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Task</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <TaskForm
              prefill={createTaskPrefill}
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
                clearCreateTaskPrefill()
                if (newTask) {
                  if (sidebarView === 'canvas') {
                    setCanvasPendingTaskId(newTask.id)
                  } else {
                    selectTask(newTask.id)
                    // Navigate to tasks view to show the newly created task
                    setSidebarView('tasks')
                  }
                }
              }}
              onCancel={() => { closeModal(); clearCreateTaskPrefill() }}
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
              // Clear pending task if it's the one being deleted
              if (canvasPendingTaskId === deletingTaskId) {
                clearCanvasPendingTask()
              }
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

      {/* Command palette (⌘K / Ctrl+K) */}
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />

      {/* Background progress toasts (setup, task progress, etc.) */}
      <ProgressToastStack />
    </>
  )
}
