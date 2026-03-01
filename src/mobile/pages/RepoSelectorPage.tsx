import { useState, useEffect, useMemo, useCallback } from 'react'
import { api } from '../api/client'
import { useTaskStore } from '../stores/task-store'
import type { Route } from '../App'

interface GitHubRepo {
  name: string
  fullName: string
  defaultBranch: string
  cloneUrl: string
  description: string
  isPrivate: boolean
}

export function RepoSelectorPage({
  taskId,
  onNavigate
}: {
  taskId: string
  onNavigate: (route: Route) => void
}) {
  const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId))
  const updateTask = useTaskStore((s) => s.updateTask)

  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initialise selected set from existing task repos
  useEffect(() => {
    if (task) {
      setSelected(new Set(task.repos))
    }
  }, [task])

  // Fetch repos from GitHub on mount
  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    api.github
      .getOrg()
      .then(({ org }) => {
        if (!org) throw new Error('No GitHub org configured in settings')
        return api.github.fetchRepos(org)
      })
      .then((data) => {
        if (!cancelled) setRepos(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() => {
    if (!search) return repos
    const q = search.toLowerCase()
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q)
    )
  }, [repos, search])

  const toggleRepo = useCallback((fullName: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(fullName)) next.delete(fullName)
      else next.add(fullName)
      return next
    })
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!task) return
    await updateTask(task.id, { repos: Array.from(selected) })
    onNavigate({ page: 'detail', taskId })
  }, [task, selected, updateTask, onNavigate, taskId])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-3 border-b border-border">
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
        <h1 className="text-sm font-semibold truncate flex-1">
          Select Repositories
        </h1>
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
            placeholder="Filter repositories..."
            className="w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
          />
        </div>
      </div>

      {/* Repo list */}
      <div className="flex-1 overflow-y-auto px-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <svg
              className="h-5 w-5 animate-spin text-muted-foreground"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </div>
        ) : error ? (
          <div className="text-center py-8 text-sm text-destructive">
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            {search ? 'No matching repositories' : 'No repositories found'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((repo) => {
              const isSelected = selected.has(repo.fullName)
              return (
                <button
                  key={repo.fullName}
                  onClick={() => toggleRepo(repo.fullName)}
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

                  {/* Repo info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {repo.name}
                      </span>
                      {repo.isPrivate ? (
                        <svg
                          className="h-3 w-3 text-muted-foreground shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect
                            width="18"
                            height="11"
                            x="3"
                            y="11"
                            rx="2"
                            ry="2"
                          />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      ) : (
                        <svg
                          className="h-3 w-3 text-muted-foreground shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                          <path d="M2 12h20" />
                        </svg>
                      )}
                    </div>
                    {repo.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {repo.description}
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
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-t border-border">
        <span className="text-xs text-muted-foreground">
          {selected.size} repo{selected.size !== 1 ? 's' : ''} selected
        </span>
        <button
          onClick={handleConfirm}
          disabled={selected.size === 0}
          className="inline-flex items-center justify-center h-8 px-4 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 active:opacity-80 disabled:opacity-50 disabled:pointer-events-none"
        >
          Confirm
        </button>
      </div>
    </div>
  )
}
