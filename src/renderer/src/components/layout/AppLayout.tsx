import { Sidebar } from './Sidebar'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { TaskForm, type TaskFormSubmitData } from '@/components/tasks/TaskForm'
import { DeleteConfirmDialog } from '@/components/tasks/DeleteConfirmDialog'
import { AgentSettingsDialog } from '@/components/agents/AgentSettingsDialog'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle } from '@/components/ui/Dialog'
import { useTasks } from '@/hooks/use-tasks'
import { useUIStore } from '@/stores/ui-store'
import { useAgentStore } from '@/stores/agent-store'
import { useOverdueNotifications } from '@/hooks/use-overdue-notifications'
import { attachmentApi, worktreeApi, settingsApi } from '@/lib/ipc-client'
import { isOverdue } from '@/lib/utils'
import { useEffect } from 'react'
import { TaskStatus } from '@/types'
import type { FileAttachment } from '@/types'

export function AppLayout() {
  const { tasks, selectedTask, createTask, updateTask, deleteTask, selectTask } = useTasks()
  const { agents, fetchAgents, stopAndRemoveSessionForTask } = useAgentStore()
  const {
    activeModal,
    editingTaskId,
    deletingTaskId,
    openCreateModal,
    openEditModal,
    openDeleteModal,
    openAgentSettings,
    closeModal
  } = useUIStore()

  useEffect(() => {
    fetchAgents()
  }, [])

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || selectedTask : undefined
  const deletingTask = deletingTaskId ? tasks.find((t) => t.id === deletingTaskId) : undefined

  const overdueCount = tasks.filter(
    (t) => isOverdue(t.due_date) && t.status !== TaskStatus.Completed
  ).length

  useOverdueNotifications(tasks)

  return (
    <>
      {/* Sidebar — constrained to 280px by CSS Grid on #root */}
      <Sidebar
        tasks={tasks}
        selectedTaskId={selectedTask?.id || null}
        overdueCount={overdueCount}
        onSelectTask={selectTask}
        onCreateTask={openCreateModal}
        onOpenSettings={openAgentSettings}
      />

      {/* Workspace — fills remaining space via CSS Grid 1fr */}
      <main className="flex flex-col min-w-0 overflow-hidden bg-background">
        {/* Drag region for macOS traffic lights */}
        <div className="drag-region h-12 flex-shrink-0" />
        <div className="flex-1 overflow-hidden">
          <TaskWorkspace
            task={selectedTask}
            agents={agents}
            onEdit={() => {
              if (selectedTask) openEditModal(selectedTask.id)
            }}
            onDelete={() => {
              if (selectedTask) openDeleteModal(selectedTask.id)
            }}
            onUpdateChecklist={async (checklist) => {
              if (selectedTask) {
                await updateTask(selectedTask.id, { checklist })
              }
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
              if (selectedTask) {
                await updateTask(selectedTask.id, { status: TaskStatus.Completed })
              }
            }}
            onAssignAgent={async (taskId, agentId) => {
              await updateTask(taskId, { agent_id: agentId })
            }}
            onUpdateTask={async (taskId, data) => {
              await updateTask(taskId, data)
            }}
          />
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

      {/* Agent Settings Dialog */}
      <AgentSettingsDialog />
    </>
  )
}
