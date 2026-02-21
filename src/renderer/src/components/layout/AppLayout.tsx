import { DepsWarningBanner } from './DepsWarningBanner'
import { UpdateBanner } from './UpdateBanner'
import { Sidebar } from './Sidebar'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { SkillWorkspace } from '@/components/skills/SkillWorkspace'
import { SettingsWorkspace } from '@/components/settings/SettingsWorkspace'
import { TaskForm, type TaskFormSubmitData } from '@/components/tasks/TaskForm'
import { DeleteConfirmDialog } from '@/components/tasks/DeleteConfirmDialog'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle } from '@/components/ui/Dialog'
import { OrchestratorPanel } from '@/components/orchestrator/OrchestratorPanel'
import { useTasks } from '@/hooks/use-tasks'
import { useUIStore } from '@/stores/ui-store'
import { useAgentStore } from '@/stores/agent-store'
import { useAgentAutoStart } from '@/hooks/use-agent-auto-start'
import { useOverdueNotifications } from '@/hooks/use-overdue-notifications'
import { attachmentApi, worktreeApi, settingsApi } from '@/lib/ipc-client'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { isOverdue, isSnoozed } from '@/lib/utils'
import { useEffect, useState, useCallback } from 'react'
import { TaskStatus } from '@/types'
import type { FileAttachment } from '@/types'
import { MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/Button'

export function AppLayout() {
  const { tasks, allTasks, selectedTask, createTask, updateTask, deleteTask, selectTask } = useTasks()
  const { agents, sessions, fetchAgents, stopAndRemoveSessionForTask } = useAgentStore()
  const { executeAction } = useTaskSourceStore()
  const {
    sidebarView,
    activeModal,
    editingTaskId,
    deletingTaskId,
    openCreateModal,
    openEditModal,
    openDeleteModal,
    openSettings,
    closeModal
  } = useUIStore()

  useEffect(() => {
    fetchAgents()
  }, [])

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || selectedTask : undefined
  const deletingTask = deletingTaskId ? tasks.find((t) => t.id === deletingTaskId) : undefined

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

  // Initialize auto-start feature
  useAgentAutoStart({
    tasks: allTasks,
    agents,
    sessions,
    showToast
  })

  return (
    <>
      {/* Sidebar — constrained to 280px by CSS Grid on #root */}
      <Sidebar
        tasks={tasks}
        selectedTaskId={selectedTask?.id || null}
        overdueCount={overdueCount}
        onSelectTask={selectTask}
        onCreateTask={openCreateModal}
        onOpenSettings={openSettings}
      />

      {/* Workspace — fills remaining space via CSS Grid 1fr */}
      <main className="flex flex-col min-w-0 overflow-hidden bg-background">
        {/* Drag region for macOS traffic lights with mastermind toggle */}
        <div className="drag-region h-12 flex-shrink-0 flex items-center justify-end px-4">
          <Button
            variant={showOrchestrator ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setShowOrchestrator(!showOrchestrator)}
            className="no-drag h-7 px-2"
          >
            <MessageSquare className="h-3.5 w-3.5 mr-1" />
            <span className="text-xs">Mastermind</span>
          </Button>
        </div>
        <DepsWarningBanner />
        <UpdateBanner />
        <div className="flex-1 overflow-hidden relative">
          {/* Main workspace content */}
          {activeModal === 'settings' ? (
            <SettingsWorkspace />
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
                    const actionValue = actionField?.value ? String(actionField.value) : undefined
                    if (actionValue) {
                      const result = await executeAction(actionValue, selectedTask.id, selectedTask.source_id)
                      if (!result.success) {
                        showToast(result.error || 'Failed to complete task', true)
                        return
                      }
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
                // Automatically select and open the newly created task
                if (newTask) {
                  selectTask(newTask.id)
                }
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
            await deleteTask(deletingTaskId)
            closeModal()
          }
        }}
        onCancel={closeModal}
      />

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 border rounded-lg shadow-lg text-sm animate-in fade-in slide-in-from-bottom-2 ${toast.isError ? 'bg-destructive text-destructive-foreground' : 'bg-card'}`}>
          {toast.message}
        </div>
      )}
    </>
  )
}
