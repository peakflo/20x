import { useState, useEffect, useMemo } from 'react'
import { Search, Lock, Globe, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { githubApi } from '@/lib/ipc-client'
import type { GitHubRepo } from '@/types/electron'

interface RepoSelectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  org: string
  initialRepos?: string[]
  onConfirm: (repos: GitHubRepo[]) => void
}

export function RepoSelectorDialog({ open, onOpenChange, org, initialRepos, onConfirm }: RepoSelectorDialogProps) {
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set(initialRepos ?? []))
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && org) {
      setIsLoading(true)
      setError(null)
      githubApi.fetchOrgRepos(org)
        .then(setRepos)
        .catch((err) => setError(err.message))
        .finally(() => setIsLoading(false))
    }
  }, [open, org])

  useEffect(() => {
    if (open && initialRepos) {
      setSelected(new Set(initialRepos))
    }
  }, [open, initialRepos])

  const filtered = useMemo(() => {
    if (!search) return repos
    const q = search.toLowerCase()
    return repos.filter((r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
  }, [repos, search])

  const toggleRepo = (fullName: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(fullName)) next.delete(fullName)
      else next.add(fullName)
      return next
    })
  }

  const handleConfirm = () => {
    const selectedRepos = repos.filter((r) => selected.has(r.fullName))
    onConfirm(selectedRepos)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Repositories</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter repositories..."
              className="w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
            />
          </div>

          {/* Repo list */}
          <div className="max-h-80 overflow-y-auto -mx-1 px-1 space-y-1">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="text-center py-8 text-sm text-destructive">{error}</div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {search ? 'No matching repositories' : 'No repositories found'}
              </div>
            ) : (
              filtered.map((repo) => (
                <label
                  key={repo.fullName}
                  className="flex items-start gap-3 rounded-md p-2.5 hover:bg-accent/50 cursor-pointer transition-colors"
                >
                  <Checkbox
                    checked={selected.has(repo.fullName)}
                    onCheckedChange={() => toggleRepo(repo.fullName)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{repo.name}</span>
                      {repo.isPrivate ? (
                        <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                      ) : (
                        <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                    </div>
                    {repo.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{repo.description}</p>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-xs text-muted-foreground">
              {selected.size} repo{selected.size !== 1 ? 's' : ''} selected
            </span>
            <Button onClick={handleConfirm} disabled={selected.size === 0}>
              Confirm
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
