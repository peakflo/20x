import { Inbox } from 'lucide-react'
import { TaskListItem } from './TaskListItem'
import { EmptyState } from '@/components/ui/EmptyState'
import type { WorkfloTask } from '@/types'

interface TaskListProps {
  tasks: WorkfloTask[]
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
}

export function TaskList({ tasks, selectedTaskId, onSelectTask }: TaskListProps) {
  if (tasks.length === 0) {
    return <EmptyState icon={Inbox} title="No tasks" description="Create a task to get started" className="py-10" />
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 pb-2">
      {tasks.map((task) => (
        <TaskListItem
          key={task.id}
          task={task}
          isSelected={task.id === selectedTaskId}
          onSelect={() => onSelectTask(task.id)}
        />
      ))}
    </div>
  )
}
