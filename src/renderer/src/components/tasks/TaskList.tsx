import { useState, useMemo } from 'react'
import { Inbox, ChevronRight } from 'lucide-react'
import { TaskListItem } from './TaskListItem'
import { EmptyState } from '@/components/ui/EmptyState'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

interface TaskListProps {
  tasks: WorkfloTask[]
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
}

export function TaskList({ tasks, selectedTaskId, onSelectTask }: TaskListProps) {
  const [completedOpen, setCompletedOpen] = useState(false)

  const { activeTasks, completedTasks } = useMemo(() => {
    const active: WorkfloTask[] = []
    const completed: WorkfloTask[] = []
    for (const task of tasks) {
      if (task.status === TaskStatus.Completed) {
        completed.push(task)
      } else {
        active.push(task)
      }
    }
    return { activeTasks: active, completedTasks: completed }
  }, [tasks])

  if (tasks.length === 0) {
    return <EmptyState icon={Inbox} title="No tasks" description="Create a task to get started" className="py-10" />
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 pb-2">
      {activeTasks.map((task) => (
        <TaskListItem
          key={task.id}
          task={task}
          isSelected={task.id === selectedTaskId}
          onSelect={() => onSelectTask(task.id)}
        />
      ))}

      {completedTasks.length > 0 && (
        <>
          <button
            onClick={() => setCompletedOpen(!completedOpen)}
            className="flex items-center gap-1.5 px-3 py-2 mt-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${completedOpen ? 'rotate-90' : ''}`} />
            Completed
            <span className="ml-auto tabular-nums">{completedTasks.length}</span>
          </button>
          {completedOpen && completedTasks.map((task) => (
            <TaskListItem
              key={task.id}
              task={task}
              isSelected={task.id === selectedTaskId}
              onSelect={() => onSelectTask(task.id)}
            />
          ))}
        </>
      )}
    </div>
  )
}
