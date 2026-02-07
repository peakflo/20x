import { Sidebar } from './Sidebar'
import { TaskWorkspace } from '@/components/tasks/TaskWorkspace'
import { TaskForm, type TaskFormSubmitData } from '@/components/tasks/TaskForm'
import { DeleteConfirmDialog } from '@/components/tasks/DeleteConfirmDialog'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle } from '@/components/ui/Dialog'
import { useTasks } from '@/hooks/use-tasks'
import { useUIStore } from '@/stores/ui-store'
import { useOverdueNotifications } from '@/hooks/use-overdue-notifications'
import { attachmentApi } from '@/lib/ipc-client'
import { isOverdue } from '@/lib/utils'
import type { FileAttachment } from '@/types'

export function AppLayout() {
  const { tasks, selectedTask, createTask, updateTask, deleteTask, selectTask } = useTasks()
  const {
    activeModal,
    editingTaskId,
    deletingTaskId,
    openCreateModal,
    openEditModal,
    openDeleteModal,
    closeModal
  } = useUIStore()

  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) || selectedTask : undefined
  const deletingTask = deletingTaskId ? tasks.find((t) => t.id === deletingTaskId) : undefined

  const overdueCount = tasks.filter(
    (t) => isOverdue(t.due_date) && t.status !== 'completed' && t.status !== 'cancelled'
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
      />

      {/* Workspace — fills remaining space via CSS Grid 1fr */}
      <main className="flex flex-col min-w-0 overflow-hidden bg-background">
        {/* Drag region for macOS traffic lights */}
        <div className="drag-region h-12 flex-shrink-0" />
        <div className="flex-1 overflow-hidden">
          <TaskWorkspace
            task={selectedTask}
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
            await deleteTask(deletingTaskId)
            closeModal()
          }
        }}
        onCancel={closeModal}
      />
    </>
  )
}
