import React, { useEffect } from 'react'
import { Pencil, Trash2, Calendar, User, Tag, Clock, Bot, Play, History, GitBranch, Plus, X, BookOpen, AlarmClockOff, BellRing, Folder, Repeat, Star, Sparkles, ListTree, ArrowLeft, ChevronRight, ChevronDown, GripVertical, Settings2, AlertCircle } from 'lucide-react'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CollapsibleDescription } from '@/components/ui/CollapsibleDescription'
import { Button } from '@/components/ui/Button'
import { TaskStatusBadge } from './TaskStatusBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskTypeBadge } from './TaskTypeBadge'
import { TaskAttachments } from './TaskAttachments'
import { Badge } from '@/components/ui/Badge'
import { formatDate, formatRelativeDate, isOverdue, isDueSoon, isSnoozed } from '@/lib/utils'
import { OutputFieldsDisplay } from './OutputFieldsDisplay'
import { useSkillStore } from '@/stores/skill-store'
import { AssigneeSelect } from './AssigneeSelect'
import { TaskStatus, CodingAgentType } from '@/types'
import type { WorkfloTask, FileAttachment, OutputField, Agent, RecurrencePattern, RecurrencePatternObject } from '@/types'
import { AnthropicLogo, OpenCodeLogo, OpenAILogo } from '@/components/icons/AgentLogos'
import { HeartbeatSection } from './HeartbeatSection'
import { isAgentConfigured, getAgentConfigIssue } from '@shared/agent-utils'

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  const last = n % 10
  if (last === 1) return `${n}st`
  if (last === 2) return `${n}nd`
  if (last === 3) return `${n}rd`
  return `${n}th`
}

function formatCronExpression(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return cron

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  // Weekly pattern
  if (dayOfWeek !== '*') {
    const days = dayOfWeek.split(',').flatMap(part => {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number)
        const result: number[] = []
        for (let i = start; i <= end; i++) result.push(i)
        return result
      }
      return [parseInt(part)]
    }).filter(n => !isNaN(n)).map(d => dayNames[d]).join(', ')
    return `Weekly on ${days} at ${time}`
  }

  // Monthly pattern
  if (dayOfMonth !== '*' && !dayOfMonth.startsWith('*/')) {
    return `Monthly on the ${ordinal(parseInt(dayOfMonth))} at ${time}`
  }

  // Daily pattern
  if (dayOfMonth.startsWith('*/')) {
    const interval = parseInt(dayOfMonth.slice(2))
    return `Every ${interval} days at ${time}`
  }

  return `Daily at ${time}`
}

function formatLegacyPattern(pattern: RecurrencePatternObject): string {
  const { type, interval, time, weekdays, monthDay } = pattern

  let description = ''

  if (type === 'daily') {
    description = interval === 1 ? 'Daily' : `Every ${interval} days`
  } else if (type === 'weekly') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const days = weekdays?.map(d => dayNames[d]).join(', ') || ''
    description = `Weekly on ${days}`
  } else if (type === 'monthly') {
    description = `Monthly on the ${ordinal(monthDay ?? 1)}`
  } else {
    description = `Every ${interval} days`
  }

  return `${description} at ${time}`
}

function formatRecurrencePattern(pattern: RecurrencePattern): string {
  if (typeof pattern === 'string') return formatCronExpression(pattern)
  return formatLegacyPattern(pattern)
}

const subtaskStatusDotColor: Record<TaskStatus, string> = {
  [TaskStatus.NotStarted]: 'bg-muted-foreground',
  [TaskStatus.Triaging]: 'bg-muted-foreground animate-pulse',
  [TaskStatus.AgentWorking]: 'bg-amber-400 animate-pulse',
  [TaskStatus.ReadyForReview]: 'bg-purple-400',
  [TaskStatus.AgentLearning]: 'bg-blue-400 animate-pulse',
  [TaskStatus.Completed]: 'bg-emerald-400'
}

function SortableSubtaskItem({ subtask, onNavigateToTask }: { subtask: WorkfloTask; onNavigateToTask?: (taskId: string) => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: subtask.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 px-1 py-2.5 hover:bg-accent/50 transition-colors"
    >
      <button
        className="shrink-0 cursor-grab active:cursor-grabbing p-1 text-muted-foreground/50 hover:text-muted-foreground touch-none"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => onNavigateToTask?.(subtask.id)}
        className="flex-1 flex items-center gap-3 text-left cursor-pointer min-w-0 pr-2"
      >
        <div className={`h-2 w-2 rounded-full shrink-0 ${subtaskStatusDotColor[subtask.status]}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm truncate">{subtask.title}</div>
        </div>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </button>
    </div>
  )
}

function SubtasksSection({ subtasks, onNavigateToTask, onAddSubtask, onReorderSubtasks }: { subtasks: WorkfloTask[]; onNavigateToTask?: (taskId: string) => void; onAddSubtask?: (title: string) => void; onReorderSubtasks?: (orderedIds: string[]) => void }) {
  const [isAdding, setIsAdding] = React.useState(false)
  const [newTitle, setNewTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const completedCount = subtasks.filter(s => s.status === TaskStatus.Completed).length

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  React.useEffect(() => {
    if (isAdding) inputRef.current?.focus()
  }, [isAdding])

  const handleSubmit = () => {
    const title = newTitle.trim()
    if (title && onAddSubtask) {
      onAddSubtask(title)
      setNewTitle('')
      setIsAdding(false)
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = subtasks.findIndex(s => s.id === active.id)
    const newIndex = subtasks.findIndex(s => s.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(subtasks, oldIndex, newIndex)
    onReorderSubtasks?.(reordered.map(s => s.id))
  }

  const subtaskIds = subtasks.map(s => s.id)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ListTree className="h-3.5 w-3.5" /> Subtasks
          {subtasks.length > 0 && (
            <span className="text-xs tabular-nums">({completedCount}/{subtasks.length})</span>
          )}
        </div>
        {onAddSubtask && !isAdding && (
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        )}
      </div>
      <div className="rounded-md border divide-y">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={subtaskIds} strategy={verticalListSortingStrategy}>
            {subtasks.map((subtask) => (
              <SortableSubtaskItem
                key={subtask.id}
                subtask={subtask}
                onNavigateToTask={onNavigateToTask}
              />
            ))}
          </SortableContext>
        </DndContext>
        {isAdding && (
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="h-2 w-2 rounded-full shrink-0 bg-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit()
                if (e.key === 'Escape') { setIsAdding(false); setNewTitle('') }
              }}
              onBlur={() => { if (!newTitle.trim()) { setIsAdding(false); setNewTitle('') } }}
              placeholder="Subtask title..."
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground/50"
            />
            <button onClick={handleSubmit} className="text-xs text-primary hover:text-primary/80 cursor-pointer">Add</button>
            <button onClick={() => { setIsAdding(false); setNewTitle('') }} className="text-xs text-muted-foreground hover:text-foreground cursor-pointer">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ParentTaskContext({ parentTask, onNavigateToTask }: { parentTask: WorkfloTask; onNavigateToTask: (taskId: string) => void }) {
  const [isExpanded, setIsExpanded] = React.useState(false)

  return (
    <div className="mb-4 rounded-lg border border-border/60 bg-accent/30">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 flex items-center gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-accent/50 rounded-lg transition-colors"
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-xs text-muted-foreground shrink-0">Parent task:</span>
          <span className="text-sm truncate">{parentTask.title}</span>
        </button>
        <button
          onClick={() => onNavigateToTask(parentTask.id)}
          className="shrink-0 mr-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1"
          title="Go to parent task"
        >
          <ArrowLeft className="h-3 w-3" />
          Go to parent
        </button>
      </div>
      {isExpanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-border/40">
          <div className="flex items-center gap-2 pt-3">
            <TaskStatusBadge status={parentTask.status} />
            <TaskTypeBadge type={parentTask.type} />
            <TaskPriorityBadge priority={parentTask.priority} />
          </div>
          {parentTask.description && (
            <CollapsibleDescription
              taskId={parentTask.id}
              description={parentTask.description}
              size="sm"
              className="text-sm text-muted-foreground"
            />
          )}
          {parentTask.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {parentTask.labels.map((label) => (
                <Badge key={label} variant="blue" className="text-[10px]">{label}</Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Inline warning shown under the Agent row when the task's agent (or, when no
 * agent is assigned, the default agent picked by Triage) is missing a provider
 * or model. Blocks the user from starting/triaging until they fix it.
 */
function AgentConfigWarning({ task, agents, onEditAgent }: { task: WorkfloTask; agents: Agent[]; onEditAgent?: (agentId: string) => void }) {
  // When a specific agent is assigned, warn about that agent.
  // Otherwise, warn about the default agent used by Triage.
  const assignedAgent = task.agent_id ? agents.find((a) => a.id === task.agent_id) : null
  const triageAgent = !task.agent_id ? (agents.find((a) => a.is_default) || agents[0] || null) : null
  const targetAgent = assignedAgent || triageAgent
  if (!targetAgent) return null
  if (isAgentConfigured(targetAgent)) return null

  const issue = getAgentConfigIssue(targetAgent) || 'Agent is not fully configured'
  const isAssigned = !!assignedAgent
  const action = isAssigned ? 'Start' : 'Triage'
  const message = isAssigned
    ? `${issue}. ${action} is disabled — edit the agent to continue.`
    : `The default agent "${targetAgent.name}" is not fully configured (${issue.toLowerCase()}). ${action} is disabled — edit the agent to continue.`

  return (
    <div
      data-testid="agent-config-warning"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="leading-snug">{message}</p>
        {onEditAgent && (
          <button
            type="button"
            onClick={() => onEditAgent(targetAgent.id)}
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-200 transition-colors cursor-pointer"
            data-testid="agent-config-warning-edit"
          >
            <Settings2 className="h-3 w-3" />
            Edit agent
          </button>
        )}
      </div>
    </div>
  )
}

interface TaskDetailViewProps {
  task: WorkfloTask
  agents: Agent[]
  onEdit: () => void
  onDelete: () => void
  onUpdateAttachments: (attachments: FileAttachment[]) => void
  onUpdateOutputFields: (fields: OutputField[]) => void
  onCompleteTask: () => void
  onAssignAgent: (agentId: string | null) => void
  onUpdateRepos: (repos: string[]) => void
  onAddRepos: () => void
  onUpdateSkillIds?: (skillIds: string[] | null) => void
  onAddSkills?: () => void
  onStartAgent?: () => void
  canStartAgent?: boolean
  onResumeAgent?: () => void
  canResumeAgent?: boolean
  onRestartAgent?: () => void
  canRestartAgent?: boolean
  onSnooze?: () => void
  onUnsnooze?: () => void
  onReassign?: (userIds: string[], displayName: string) => Promise<void>
  onTriage?: () => void
  canTriage?: boolean
  /** Open the agent editor dialog for a specific agent (or the currently assigned one). */
  onEditAgent?: (agentId: string) => void
  /** Save an inline description edit. When provided, the description becomes editable. */
  onUpdateDescription?: (description: string) => void | Promise<void>
  subtasks?: WorkfloTask[]
  parentTask?: WorkfloTask | null
  onNavigateToTask?: (taskId: string) => void
  onAddSubtask?: (title: string) => void
  onReorderSubtasks?: (orderedIds: string[]) => void
}

export function TaskDetailView({ task, agents, onEdit, onDelete, onUpdateAttachments, onUpdateOutputFields, onCompleteTask, onAssignAgent, onUpdateRepos, onAddRepos, onUpdateSkillIds, onAddSkills, onStartAgent, canStartAgent, onResumeAgent, canResumeAgent, onRestartAgent, canRestartAgent, onSnooze, onUnsnooze, onReassign, onTriage, canTriage, onEditAgent, onUpdateDescription, subtasks, parentTask, onNavigateToTask, onAddSubtask, onReorderSubtasks }: TaskDetailViewProps) {
  const { skills, fetchSkills } = useSkillStore()
  const isActive = task.status !== TaskStatus.Completed

  // Ensure skills are loaded for badge display
  useEffect(() => {
    if (task.agent_id && Array.isArray(task.skill_ids)) {
      fetchSkills()
    }
  }, [task.agent_id, task.skill_ids])
  const overdue = isActive && isOverdue(task.due_date)
  const dueSoon = isActive && !overdue && isDueSoon(task.due_date)

  const handleOpenFolder = async () => {
    const workspaceDir = await window.electronAPI.tasks.getWorkspaceDir(task.id)
    await window.electronAPI.shell.openPath(workspaceDir)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <TaskStatusBadge status={task.status} />
          <TaskTypeBadge type={task.type} />
          <TaskPriorityBadge priority={task.priority} />
        </div>
        <div className="flex items-center gap-1">
          {isActive && isSnoozed(task.snoozed_until) && onUnsnooze && (
            <Button variant="ghost" size="sm" onClick={onUnsnooze}>
              <BellRing className="h-3.5 w-3.5" />
              Unsnooze
            </Button>
          )}
          {isActive && !isSnoozed(task.snoozed_until) && onSnooze && (
            <Button variant="ghost" size="sm" onClick={onSnooze}>
              <AlarmClockOff className="h-3.5 w-3.5" />
              Snooze
            </Button>
          )}
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
          {parentTask && onNavigateToTask && (
            <ParentTaskContext parentTask={parentTask} onNavigateToTask={onNavigateToTask} />
          )}

          <div>
            <h1 className="text-xl font-semibold">{task.title}</h1>
            {(task.description || onUpdateDescription) && (
              <CollapsibleDescription
                taskId={task.id}
                description={task.description}
                size="sm"
                className="mt-3 text-muted-foreground"
                onSave={onUpdateDescription}
              />
            )}
          </div>

          <div className="grid grid-cols-[auto_1fr] gap-x-10 gap-y-4 text-sm">
            <>
              <span className="text-muted-foreground flex items-center gap-2"><User className="h-3.5 w-3.5" /> Assignee</span>
              <AssigneeSelect
                assignee={task.assignee}
                sourceId={task.source_id}
                taskId={task.id}
                onReassign={(userIds, displayName) => onReassign?.(userIds, displayName)}
              />
            </>
            <>
              <span className="text-muted-foreground flex items-center gap-2"><Bot className="h-3.5 w-3.5" /> Agent</span>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 flex-wrap">
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
                  {task.agent_id && agents.find(a => a.id === task.agent_id)?.config.coding_agent && (() => {
                    const agent = agents.find(a => a.id === task.agent_id)
                    const codingAgent = agent?.config.coding_agent
                    const agentName = codingAgent === CodingAgentType.CLAUDE_CODE ? 'Claude Code' :
                                     codingAgent === CodingAgentType.OPENCODE ? 'OpenCode' :
                                     'Codex'
                    const LogoComponent = codingAgent === CodingAgentType.CLAUDE_CODE ? AnthropicLogo :
                                         codingAgent === CodingAgentType.OPENCODE ? OpenCodeLogo :
                                         OpenAILogo
                    return (
                      <div
                        className="w-4 h-4 flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
                        title={agentName}
                      >
                        <LogoComponent className="w-full h-full" />
                      </div>
                    )
                  })()}
                  {/* Per-row action buttons are outline/secondary — the big
                      state-aware primary CTA lives at the bottom of the view
                      (see the prioritized CTA section). Keeping these inline
                      for quick access but visually secondary so there's only
                      one primary-colored button on screen at a time. */}
                  {canTriage && onTriage && (
                    <Button variant="outline" size="sm" onClick={onTriage} className="h-7 gap-1.5 px-3">
                      <Sparkles className="h-3 w-3" />
                      Triage
                    </Button>
                  )}
                  {canResumeAgent && onResumeAgent && (
                    <Button variant="outline" size="sm" onClick={onResumeAgent} className="h-7 gap-1.5 px-3">
                      <History className="h-3 w-3" />
                      Resume session
                    </Button>
                  )}
                  {canRestartAgent && onRestartAgent && (
                    <Button variant="outline" size="sm" onClick={onRestartAgent} className="h-7 gap-1.5 px-3">
                      <Play className="h-3 w-3" />
                      Restart session
                    </Button>
                  )}
                  {canStartAgent && onStartAgent && (
                    <Button variant="outline" size="sm" onClick={onStartAgent} className="h-7 gap-1.5 px-3">
                      <Play className="h-3 w-3" />
                      Start
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {task.agent_id && onEditAgent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEditAgent(task.agent_id!)}
                      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                      title="Edit agent configuration"
                      data-testid="edit-agent-button"
                    >
                      <Settings2 className="h-3 w-3" />
                      Edit agent
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenFolder}
                    className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                    title="Open workspace folder"
                  >
                    <Folder className="h-3 w-3" />
                    Open workspace folder
                  </Button>
                </div>
                <AgentConfigWarning
                  task={task}
                  agents={agents}
                  onEditAgent={onEditAgent}
                />
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
            {task.agent_id && onUpdateSkillIds && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><BookOpen className="h-3.5 w-3.5" /> Skills</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {!Array.isArray(task.skill_ids) ? (
                    <span className="text-sm text-muted-foreground">Using agent defaults</span>
                  ) : (
                    <>
                      {task.skill_ids.map((skillId) => {
                        const skill = skills.find((s) => s.id === skillId)
                        if (!skill) return null
                        return (
                          <Badge key={skillId} className="gap-1 pr-1">
                            {skill.name}
                            <button
                              onClick={() => onUpdateSkillIds(task.skill_ids!.filter((id) => id !== skillId))}
                              className="rounded-full hover:bg-foreground/10 p-0.5"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </Badge>
                        )
                      })}
                    </>
                  )}
                  <Button variant="ghost" size="sm" onClick={onAddSkills} className="h-6 gap-1 px-2 text-xs text-muted-foreground">
                    <Plus className="h-3 w-3" />
                    {!Array.isArray(task.skill_ids) ? 'Customize' : 'Add'}
                  </Button>
                  {Array.isArray(task.skill_ids) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onUpdateSkillIds(null)}
                      className="h-6 text-xs text-muted-foreground"
                    >
                      Reset to defaults
                    </Button>
                  )}
                </div>
              </>
            )}
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
            {isSnoozed(task.snoozed_until) && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><AlarmClockOff className="h-3.5 w-3.5" /> Hidden until</span>
                <span className="text-muted-foreground">
                  {task.snoozed_until === '9999-12-31T00:00:00.000Z' ? 'Someday' : formatDate(task.snoozed_until)}
                </span>
              </>
            )}
            {task.is_recurring && task.recurrence_pattern && !task.recurrence_parent_id && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Repeat className="h-3.5 w-3.5" /> Recurrence</span>
                <div className="flex flex-col gap-1">
                  <span>{formatRecurrencePattern(task.recurrence_pattern)}</span>
                  {task.next_occurrence_at && (
                    <span className="text-xs text-muted-foreground">
                      Next: {formatDate(task.next_occurrence_at)}
                    </span>
                  )}
                </div>
              </>
            )}
            {task.recurrence_parent_id && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Repeat className="h-3.5 w-3.5" /> Instance</span>
                <Badge variant="blue" className="w-fit">Created from recurring template</Badge>
              </>
            )}
            {task.status === TaskStatus.Completed && task.feedback_rating && (
              <>
                <span className="text-muted-foreground flex items-center gap-2"><Star className="h-3.5 w-3.5" /> Feedback</span>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-0.5">
                    {Array.from({ length: 5 }, (_, i) => (
                      <Star
                        key={i}
                        className={`h-3.5 w-3.5 ${i < task.feedback_rating! ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30'}`}
                      />
                    ))}
                  </div>
                  {task.feedback_comment && (
                    <span className="text-muted-foreground text-xs">{task.feedback_comment}</span>
                  )}
                </div>
              </>
            )}
            <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Created</span>
            <span className="text-muted-foreground">{formatRelativeDate(task.created_at)}</span>
            <span className="text-muted-foreground flex items-center gap-2"><Clock className="h-3.5 w-3.5" /> Updated</span>
            <span className="text-muted-foreground">{formatRelativeDate(task.updated_at)}</span>
            {(task.status === TaskStatus.ReadyForReview || task.heartbeat_enabled) && (
              <HeartbeatSection task={task} />
            )}
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

          {!task.parent_task_id && (
            <SubtasksSection
              subtasks={subtasks || []}
              onNavigateToTask={onNavigateToTask}
              onAddSubtask={onAddSubtask}
              onReorderSubtasks={onReorderSubtasks}
            />
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

          {/* Heartbeat monitoring — handled inside the properties grid above */}

          {task.output_fields.length > 0 && (
            <div className="rounded-md border p-4">
              <OutputFieldsDisplay
                fields={task.output_fields}
                onChange={onUpdateOutputFields}
                isActive={isActive}
                onComplete={onCompleteTask}
                taskUpdatedAt={task.updated_at}
              />
            </div>
          )}

          {isActive && (() => {
            // Prioritized main CTA — state-aware.
            //
            // In most states the happy path is to move the task forward with an
            // agent action, so Start > Resume > Restart > Triage wins over the
            // always-available Complete escape hatch.
            //
            // In ReadyForReview the happy path flips: the agent has already
            // finished, so the user is reviewing the result and the expected
            // next step is to accept (Complete). Resume stays visible as a
            // secondary "needs another pass" affordance. Mirrors how code
            // review tools promote Merge/Approve after an agent finishes.
            type AgentAction = { label: string; icon: typeof Play; onClick: () => void; testId: string }
            let agentAction: AgentAction | null = null
            if (canStartAgent && onStartAgent) {
              agentAction = { label: 'Start Task', icon: Play, onClick: onStartAgent, testId: 'main-cta-start' }
            } else if (canResumeAgent && onResumeAgent) {
              agentAction = { label: 'Resume Session', icon: History, onClick: onResumeAgent, testId: 'main-cta-resume' }
            } else if (canRestartAgent && onRestartAgent) {
              agentAction = { label: 'Restart Session', icon: Play, onClick: onRestartAgent, testId: 'main-cta-restart' }
            } else if (canTriage && onTriage) {
              agentAction = { label: 'Triage', icon: Sparkles, onClick: onTriage, testId: 'main-cta-triage' }
            }

            const hasOutputCompleteButton = task.output_fields.length > 0
            // If OutputFieldsDisplay already renders its own Complete button (when
            // all required fields are filled), don't render another here.
            const showCompleteButton = !hasOutputCompleteButton

            const isReadyForReview = task.status === TaskStatus.ReadyForReview

            // In ReadyForReview the happy path is acceptance (Complete) — the
            // agent action stays visible for "needs another pass" but as a
            // secondary outline button. This applies even when our own Complete
            // isn't rendered (because OutputFieldsDisplay has one when
            // output_fields exist) — we still demote the agent action so there
            // aren't two green buttons on screen.
            const agentActionIsPrimary = !!agentAction && !isReadyForReview
            const completeIsPrimary =
              showCompleteButton && (!agentAction || isReadyForReview)

            if (!agentAction && !showCompleteButton) return null

            return (
              <div className="flex flex-col gap-2">
                {agentAction && agentActionIsPrimary && (
                  <Button
                    onClick={agentAction.onClick}
                    size="lg"
                    className="w-full gap-2"
                    data-testid={agentAction.testId}
                  >
                    <agentAction.icon className="h-4 w-4" />
                    {agentAction.label}
                  </Button>
                )}
                {showCompleteButton && (
                  <Button
                    onClick={onCompleteTask}
                    variant={completeIsPrimary ? 'default' : 'outline'}
                    size={completeIsPrimary ? 'lg' : 'default'}
                    className="w-full"
                    data-testid="main-cta-complete"
                  >
                    Complete Task
                  </Button>
                )}
                {agentAction && !agentActionIsPrimary && (
                  <Button
                    onClick={agentAction.onClick}
                    variant="outline"
                    className="w-full gap-2"
                    data-testid={agentAction.testId}
                  >
                    <agentAction.icon className="h-4 w-4" />
                    {agentAction.label}
                  </Button>
                )}
              </div>
            )
          })()}

          <div className="pt-2 border-t text-xs text-muted-foreground">
            Source: <Badge className="ml-1">{task.source}</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}
