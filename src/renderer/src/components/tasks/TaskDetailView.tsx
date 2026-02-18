import { useState } from 'react'
import { Pencil, Trash2, Calendar, User, Tag, Clock, Bot, Play, History, GitBranch, Plus, X, BookOpen, AlarmClockOff, BellRing, Folder, Repeat } from 'lucide-react'
import { Markdown } from '@/components/ui/Markdown'
import { Button } from '@/components/ui/Button'
import { TaskStatusBadge } from './TaskStatusBadge'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskTypeBadge } from './TaskTypeBadge'
import { TaskAttachments } from './TaskAttachments'
import { Badge } from '@/components/ui/Badge'
import { formatDate, formatRelativeDate, isOverdue, isDueSoon, isSnoozed } from '@/lib/utils'
import { OutputFieldsDisplay } from './OutputFieldsDisplay'
import { SkillSelector } from '@/components/skills/SkillSelector'
import { AssigneeSelect } from './AssigneeSelect'
import { TaskStatus, CodingAgentType } from '@/types'
import type { WorkfloTask, FileAttachment, OutputField, Agent, RecurrencePattern } from '@/types'
import { AnthropicLogo, OpenCodeLogo, OpenAILogo } from '@/components/icons/AgentLogos'

function formatRecurrencePattern(pattern: RecurrencePattern): string {
  const { type, interval, time, weekdays, monthDay } = pattern

  let description = ''

  if (type === 'daily') {
    description = interval === 1 ? 'Daily' : `Every ${interval} days`
  } else if (type === 'weekly') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const days = weekdays?.map(d => dayNames[d]).join(', ') || ''
    description = `Weekly on ${days}`
  } else if (type === 'monthly') {
    const suffix = monthDay === 1 ? 'st' : monthDay === 2 ? 'nd' : monthDay === 3 ? 'rd' : 'th'
    description = `Monthly on the ${monthDay}${suffix}`
  } else {
    description = `Every ${interval} days`
  }

  return `${description} at ${time}`
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
  onStartAgent?: () => void
  canStartAgent?: boolean
  onResumeAgent?: () => void
  canResumeAgent?: boolean
  onRestartAgent?: () => void
  canRestartAgent?: boolean
  onSnooze?: () => void
  onUnsnooze?: () => void
  onReassign?: (userIds: string[], displayName: string) => Promise<void>
}

export function TaskDetailView({ task, agents, onEdit, onDelete, onUpdateAttachments, onUpdateOutputFields, onCompleteTask, onAssignAgent, onUpdateRepos, onAddRepos, onUpdateSkillIds, onStartAgent, canStartAgent, onResumeAgent, canResumeAgent, onRestartAgent, canRestartAgent, onSnooze, onUnsnooze, onReassign }: TaskDetailViewProps) {
  const [skillsExpanded, setSkillsExpanded] = useState(false)
  const isActive = task.status !== TaskStatus.Completed
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
          <div>
            <h1 className="text-xl font-semibold">{task.title}</h1>
            {task.description && (
              <div className="mt-3 text-muted-foreground">
                <Markdown size="sm">{task.description}</Markdown>
              </div>
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
                {canResumeAgent && onResumeAgent && (
                  <Button variant="default" size="sm" onClick={onResumeAgent} className="h-7 gap-1.5 px-3">
                    <History className="h-3 w-3" />
                    Resume session
                  </Button>
                )}
                {canRestartAgent && onRestartAgent && (
                  <Button variant="default" size="sm" onClick={onRestartAgent} className="h-7 gap-1.5 px-3">
                    <Play className="h-3 w-3" />
                    Restart session
                  </Button>
                )}
                {canStartAgent && onStartAgent && (
                  <Button variant="default" size="sm" onClick={onStartAgent} className="h-7 gap-1.5 px-3">
                    <Play className="h-3 w-3" />
                    Start
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleOpenFolder}
                  className="h-7 w-7"
                  title="Open workspace folder"
                >
                  <Folder className="h-3.5 w-3.5" />
                </Button>
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
                <div>
                  {task.skill_ids === null && !skillsExpanded ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Using agent defaults</span>
                      <Button variant="ghost" size="sm" onClick={() => setSkillsExpanded(true)} className="h-6 text-xs">
                        Customize
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <SkillSelector
                        selectedIds={task.skill_ids === null ? undefined : task.skill_ids}
                        onChange={(ids) => {
                          // undefined → null (agent defaults), string[] → string[]
                          onUpdateSkillIds(ids === undefined ? null : ids)
                        }}
                      />
                      {task.skill_ids !== null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { onUpdateSkillIds(null); setSkillsExpanded(false) }}
                          className="h-6 text-xs text-muted-foreground"
                        >
                          Reset to agent defaults
                        </Button>
                      )}
                    </div>
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

          {task.attachments.length > 0 && (
            <div className="rounded-md border p-4">
              <TaskAttachments
                items={task.attachments}
                onChange={onUpdateAttachments}
                taskId={task.id}
              />
            </div>
          )}

          {task.output_fields.length > 0 ? (
            <div className="rounded-md border p-4">
              <OutputFieldsDisplay
                fields={task.output_fields}
                onChange={onUpdateOutputFields}
                isActive={isActive}
                onComplete={onCompleteTask}
                taskUpdatedAt={task.updated_at}
              />
            </div>
          ) : isActive && (
            <Button onClick={onCompleteTask} className="w-full">
              Complete Task
            </Button>
          )}

          <div className="pt-2 border-t text-xs text-muted-foreground">
            Source: <Badge className="ml-1">{task.source}</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}
