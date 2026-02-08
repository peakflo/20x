import { useEffect, useState } from 'react'
import { Pencil, Trash2, Calendar, User, Tag, Clock, Bot, Play, GitBranch, CheckCircle, XCircle, Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { TaskStatusBadge } from './TaskStatusBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskTypeBadge } from './TaskTypeBadge'
import { TaskChecklist } from './TaskChecklist'
import { TaskAttachments } from './TaskAttachments'
import { Badge } from '@/components/ui/Badge'
import { formatDate, formatRelativeDate, isOverdue, isDueSoon } from '@/lib/utils'
import { pluginApi } from '@/lib/ipc-client'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { OutputFieldsDisplay } from './OutputFieldsDisplay'
import { TaskStatus } from '@/types'
import type { WorkfloTask, ChecklistItem, FileAttachment, OutputField, Agent, PluginAction } from '@/types'

interface TaskDetailViewProps {
  task: WorkfloTask
  agents: Agent[]
  onEdit: () => void
  onDelete: () => void
  onUpdateChecklist: (checklist: ChecklistItem[]) => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
  onUpdateOutputFields: (fields: OutputField[]) => void
  onCompleteTask: () => void
  onAssignAgent: (agentId: string | null) => void
  onUpdateRepos: (repos: string[]) => void
  onAddRepos: () => void
  onStartAgent?: () => void
  canStartAgent?: boolean
}

function PluginActions({ task }: { task: WorkfloTask }) {
  const { sources, executeAction } = useTaskSourceStore()
  const { fetchTasks } = useTaskStore()
  const [actions, setActions] = useState<PluginAction[]>([])
  const [executing, setExecuting] = useState<string | null>(null)
  const [inputFor, setInputFor] = useState<PluginAction | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const source = sources.find((s) => s.id === task.source_id)

  useEffect(() => {
    if (source) {
      pluginApi.getActions(source.plugin_id, source.config).then(setActions)
    }
  }, [source?.plugin_id, source?.id])

  if (!source || actions.length === 0) return null

  const isCompleted = task.status === TaskStatus.Completed

  const handleAction = async (action: PluginAction) => {
    if (action.requiresInput) {
      setInputFor(action)
      return
    }
    await doExecute(action.id)
  }

  const doExecute = async (actionId: string, input?: string) => {
    setExecuting(actionId)
    setError(null)
    const result = await executeAction(actionId, task.id, source!.id, input)
    setExecuting(null)
    setInputFor(null)
    setInputValue('')
    if (!result.success) {
      setError(result.error || 'Action failed')
    } else {
      // Refetch tasks to reflect local updates from the action
      fetchTasks()
    }
  }

  const iconMap: Record<string, typeof CheckCircle> = { CheckCircle, XCircle }

  return (
    <div className="space-y-2 pt-2 border-t">
      <span className="text-xs text-muted-foreground">Actions</span>
      {isCompleted ? (
        <p className="text-xs text-muted-foreground">No actions available for completed tasks.</p>
      ) : inputFor ? (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">{inputFor.inputLabel || 'Input'}</label>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={inputFor.inputPlaceholder}
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => doExecute(inputFor.id, inputValue)} disabled={!inputValue.trim()}>
              {executing === inputFor.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Submit
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setInputFor(null); setInputValue('') }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {actions.map((action) => {
            const Icon = action.icon ? iconMap[action.icon] : undefined
            return (
              <Button
                key={action.id}
                size="sm"
                variant={action.variant === 'destructive' ? 'destructive' : 'outline'}
                onClick={() => handleAction(action)}
                disabled={executing !== null}
              >
                {executing === action.id ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : Icon ? (
                  <Icon className="h-3 w-3 mr-1" />
                ) : null}
                {action.label}
              </Button>
            )
          })}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function TaskDetailView({ task, agents, onEdit, onDelete, onUpdateChecklist, onUpdateAttachments, onUpdateOutputFields, onCompleteTask, onAssignAgent, onUpdateRepos, onAddRepos, onStartAgent, canStartAgent }: TaskDetailViewProps) {
  const isActive = task.status !== TaskStatus.Completed
  const overdue = isActive && isOverdue(task.due_date)
  const dueSoon = isActive && !overdue && isDueSoon(task.due_date)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <TaskStatusBadge status={task.status} />
          <TaskTypeBadge type={task.type} />
          <TaskPriorityBadge priority={task.priority} />
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8 space-y-6">
          <div>
            <h1 className="text-xl font-semibold">{task.title}</h1>
            {task.description && (
              <p className="mt-3 text-sm text-muted-foreground whitespace-pre-wrap">{task.description}</p>
            )}
          </div>

          <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-4 text-sm">
            {task.assignee && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><User className="h-3.5 w-3.5" /> Assignee</span>
                <span>{task.assignee}</span>
              </>
            )}
            <>
              <span className="text-muted-foreground flex items-center gap-2"><Bot className="h-3.5 w-3.5" /> Agent</span>
              <div className="flex items-center gap-2">
                <select
                  value={task.agent_id || ''}
                  onChange={(e) => onAssignAgent(e.target.value || null)}
                  className="bg-transparent border border-border rounded px-2 py-1 text-sm cursor-pointer"
                >
                  <option value="">No agent assigned</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
                {canStartAgent && onStartAgent && (
                  <Button variant="default" size="sm" onClick={onStartAgent} className="h-7 gap-1.5 px-3">
                    <Play className="h-3 w-3" />
                    Start
                  </Button>
                )}
              </div>
            </>
            <>
              <span className="text-muted-foreground flex items-center gap-2"><GitBranch className="h-3.5 w-3.5" /> Repos</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {task.repos.map((repo) => (
                  <Badge key={repo} className="gap-1 pr-1">
                    {repo.split('/').pop()}
                    <button
                      onClick={() => onUpdateRepos(task.repos.filter((r) => r !== repo))}
                      className="rounded-full hover:bg-foreground/10 p-0.5"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </Badge>
                ))}
                <Button variant="ghost" size="sm" onClick={onAddRepos} className="h-6 gap-1 px-2 text-xs text-muted-foreground">
                  <Plus className="h-3 w-3" />
                  Add
                </Button>
              </div>
            </>
            {task.due_date && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Calendar className="h-3.5 w-3.5" /> Due date</span>
                <span className={overdue ? 'text-destructive' : dueSoon ? 'text-amber-400' : ''}>
                  {formatDate(task.due_date)}
                  {overdue && <Badge variant="red" className="ml-2">Overdue</Badge>}
                  {dueSoon && <Badge variant="yellow" className="ml-2">Due soon</Badge>}
                </span>
              </>
            )}
            <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Created</span>
            <span className="text-muted-foreground">{formatRelativeDate(task.created_at)}</span>
            <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Updated</span>
            <span className="text-muted-foreground">{formatRelativeDate(task.updated_at)}</span>
          </div>

          {task.labels.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Tag className="h-3.5 w-3.5" /> Labels
              </div>
              <div className="flex flex-wrap gap-1.5">
                {task.labels.map((label) => (
                  <Badge key={label} variant="blue">{label}</Badge>
                ))}
              </div>
            </div>
          )}

          {task.checklist.length > 0 && (
            <div className="rounded-md border p-4">
              <TaskChecklist items={task.checklist} onChange={onUpdateChecklist} />
            </div>
          )}

          {task.attachments.length > 0 && (
            <div className="rounded-md border p-4">
              <TaskAttachments
                items={task.attachments}
                onChange={onUpdateAttachments}
                taskId={task.id}
              />
            </div>
          )}

          {task.output_fields.length > 0 && (
            <div className="rounded-md border p-4">
              <OutputFieldsDisplay
                fields={task.output_fields}
                onChange={onUpdateOutputFields}
                isActive={isActive}
                onComplete={onCompleteTask}
              />
            </div>
          )}

          {task.source_id && <PluginActions task={task} />}

          <div className="pt-2 border-t text-xs text-muted-foreground">
            Source: <Badge className="ml-1">{task.source}</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}
