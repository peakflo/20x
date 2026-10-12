import { useState, useMemo, useCallback } from 'react'
import { useTaskStore } from '../stores/task-store'
import { useAgentStore } from '../stores/agent-store'
import type { Route } from '../App'

export function SkillSelectorPage({
  taskId,
  onNavigate
}: {
  taskId: string
  onNavigate: (route: Route) => void
}) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const updateTask = useTaskStore((s) => s.updateTask)
  const skills = useAgentStore((s) => s.skills)

  const [selected, setSelected] = useState<Set<string>>(() => new Set(task?.skill_ids ?? []))
  const [search, setSearch] = useState('')

  // Filter skills relevant to this agent
  const agentSkills = useMemo(() => {
    if (!task?.agent_id) return skills
    return skills.filter((s) => !s.agent_id || s.agent_id === task.agent_id)
  }, [skills, task?.agent_id])

  const filtered = useMemo(() => {
    if (!search) return agentSkills
    const q = search.toLowerCase()
    return agentSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q)
    )
  }, [agentSkills, search])

  const toggleSkill = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!task) return
    const success = await updateTask(task.id, { skill_ids: Array.from(selected) })
    if (success) onNavigate({ page: 'detail', taskId })
  }, [task, selected, updateTask, onNavigate, taskId])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="glass-bar relative z-10 shrink-0 flex items-center gap-2 px-2 py-3 border-b">
        <button
          onClick={() => onNavigate({ page: 'detail', taskId })}
          className="p-2 active:opacity-60 hover:bg-accent rounded-md transition-colors"
        >
          <svg
            className="w-5 h-5 text-foreground"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-sm font-semibold truncate flex-1">Select Skills</h1>
      </div>

      {/* Search */}
      <div className="px-4 pt-3 pb-2 shrink-0">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter skills..."
            className="w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
          />
        </div>
      </div>

      {/* Skill list */}
      <div className="flex-1 overflow-y-auto px-4">
        {filtered.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            {search ? 'No matching skills' : 'No skills available'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((skill) => {
              const isSelected = selected.has(skill.id)
              return (
                <button
                  key={skill.id}
                  onClick={() => toggleSkill(skill.id)}
                  className="flex items-start gap-3 rounded-md p-2.5 w-full text-left hover:bg-accent/50 active:bg-accent/70 transition-colors"
                >
                  {/* Checkbox */}
                  <div
                    className={`mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors ${
                      isSelected
                        ? 'bg-primary border-primary text-primary-foreground'
                        : 'border-muted-foreground/40'
                    }`}
                  >
                    {isSelected && (
                      <svg
                        className="h-3 w-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>

                  {/* Skill info */}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{skill.name}</span>
                    {skill.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {skill.description}
                      </p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="glass-bar shrink-0 flex items-center justify-between px-4 py-3 border-t">
        <span className="text-xs text-muted-foreground">
          {selected.size} skill{selected.size !== 1 ? 's' : ''} selected
        </span>
        <button
          onClick={handleConfirm}
          className="inline-flex items-center justify-center h-8 px-4 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 active:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
        >
          Confirm
        </button>
      </div>
    </div>
  )
}
