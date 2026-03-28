import { useState, useEffect, useMemo } from 'react'
import { Search, Lock, Globe, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Select } from '@/components/ui/Select'
import { getGitProviderApi } from '@/lib/git-provider-api'
import { useSettingsStore } from '@/stores/settings-store'
import type { GitHubRepo } from '@/types/electron'

interface RepoSelectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  org: string
  initialRepos?: string[]
  onConfirm: (repos: GitHubRepo[], org: string) => void
}

export function RepoSelectorDialog({ open, onOpenChange, org, initialRepos, onConfirm }: RepoSelectorDialogProps) {
  const gitProvider = useSettingsStore((s) => s.gitProvider)
  const providerApi = useMemo(() => getGitProviderApi(gitProvider), [gitProvider])


  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [selectedOrg, setSelectedOrg] = useState(org)
  const [owners, setOwners] = useState<{ value: string; label: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingOwners, setIsLoadingOwners] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setSelectedOrg(org)
    }
  }, [open, org])

  useEffect(() => {
    if (open && selectedOrg) {
      setIsLoading(true)
      setError(null)
      providerApi.fetchOrgRepos(selectedOrg)
        .then(setRepos)
        .catch((err) => setError(err.message))
        .finally(() => setIsLoading(false))
    }
  }, [open, selectedOrg, providerApi])

  useEffect(() => {
    if (open) {
      const initial = (initialRepos ?? []).filter((repo) => repo.startsWith(`${selectedOrg}/`))
      setSelected(new Set(initial))
    }
  }, [open, initialRepos, selectedOrg])

  useEffect(() => {
    if (!open) return
    setIsLoadingOwners(true)

    Promise.all([providerApi.checkCli(), providerApi.fetchOrgs()])
      .then(([status, orgs]) => {
        const list: { value: string; label: string }[] = []
        if (status.username) {
          list.push({ value: status.username, label: `${status.username} (personal)` })
        }
        for (const orgName of orgs) {
          list.push({ value: orgName, label: orgName })
        }

        if (selectedOrg && !list.some((o) => o.value === selectedOrg)) {
          list.unshift({ value: selectedOrg, label: selectedOrg })
        }

        setOwners(list)
      })
      .catch(() => {
        if (selectedOrg) {
          setOwners([{ value: selectedOrg, label: selectedOrg }])
        } else {
          setOwners([])
        }
      })
      .finally(() => setIsLoadingOwners(false))
  }, [open, selectedOrg, providerApi])

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
    onConfirm(selectedRepos, selectedOrg)
  }

  const selectedInCurrentOrg = repos.filter((r) => selected.has(r.fullName)).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Repositories</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="repo-selector-org" className="text-xs font-medium text-muted-foreground">
              Organization
            </label>
            {isLoadingOwners ? (
              <div className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading organizations...
              </div>
            ) : (
              <Select
                id="repo-selector-org"
                value={selectedOrg}
                options={owners}
                onChange={(e) => setSelectedOrg(e.target.value)}
                disabled={owners.length === 0}
              />
            )}
          </div>

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
              {selectedInCurrentOrg} repo{selectedInCurrentOrg !== 1 ? 's' : ''} selected
            </span>
            <Button onClick={handleConfirm} disabled={selectedInCurrentOrg === 0}>
              Confirm
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
