import { useState, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Select } from '@/components/ui/Select'
import { GhCliSetupDialog } from '@/components/github/GhCliSetupDialog'
import { githubApi } from '@/lib/ipc-client'
import type { GitHubRepo } from '@/types/electron'
import type { PluginFormProps } from './PluginFormProps'

export function GitHubIssuesConfigForm({ value, onChange }: PluginFormProps) {
  const [ghReady, setGhReady] = useState<boolean | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [owners, setOwners] = useState<{ value: string; label: string }[]>([])
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [loadingOwners, setLoadingOwners] = useState(false)
  const [loadingRepos, setLoadingRepos] = useState(false)

  const updateField = useCallback(
    (key: string, val: unknown) => onChange({ ...value, [key]: val }),
    [value, onChange]
  )

  // Check gh CLI on mount
  useEffect(() => {
    githubApi.checkCli().then((status) => {
      if (!status.authenticated) {
        setGhReady(false)
        setShowSetup(true)
      } else {
        setGhReady(true)
      }
    })
  }, [])

  // Load owners when gh is ready
  useEffect(() => {
    if (!ghReady) return
    setLoadingOwners(true)

    Promise.all([
      githubApi.checkCli(),
      githubApi.fetchOrgs()
    ]).then(([status, orgs]) => {
      const list: { value: string; label: string }[] = []
      if (status.username) {
        list.push({ value: status.username, label: `${status.username} (personal)` })
      }
      for (const org of orgs) {
        list.push({ value: org, label: org })
      }
      setOwners(list)
    }).finally(() => setLoadingOwners(false))
  }, [ghReady])

  // Load repos when owner changes
  useEffect(() => {
    const owner = value.owner as string
    if (!owner || !ghReady) {
      setRepos([])
      return
    }

    setLoadingRepos(true)

    const isPersonal = owners.some(
      (o) => o.value === owner && o.label.includes('(personal)')
    )

    const fetchFn = isPersonal
      ? githubApi.fetchUserRepos()
      : githubApi.fetchOrgRepos(owner)

    fetchFn
      .then((r) => setRepos(r))
      .catch(() => setRepos([]))
      .finally(() => setLoadingRepos(false))
  }, [value.owner, ghReady, owners])

  if (ghReady === null) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const ownerOptions = [{ value: '', label: 'Select owner...' }, ...owners]
  const repoOptions = [
    { value: '', label: value.owner ? 'Select repository...' : 'Select an owner first' },
    ...repos.map((r) => ({ value: r.name, label: r.name }))
  ]

  return (
    <>
      <GhCliSetupDialog
        open={showSetup}
        onOpenChange={setShowSetup}
        onComplete={() => {
          setShowSetup(false)
          setGhReady(true)
        }}
      />

      <div className="space-y-3">
        {/* Owner */}
        <div className="space-y-1.5">
          <Label>Owner</Label>
          {loadingOwners ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...
            </div>
          ) : (
            <Select
              options={ownerOptions}
              value={(value.owner as string) || ''}
              onChange={(e) => onChange({ ...value, owner: e.target.value, repo: '' })}
            />
          )}
        </div>

        {/* Repo */}
        <div className="space-y-1.5">
          <Label>Repository</Label>
          {loadingRepos ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading repos...
            </div>
          ) : (
            <Select
              options={repoOptions}
              value={(value.repo as string) || ''}
              onChange={(e) => updateField('repo', e.target.value)}
              disabled={!value.owner}
            />
          )}
        </div>

        {/* State filter */}
        <div className="space-y-1.5">
          <Label>Issue State</Label>
          <Select
            options={[
              { value: 'open', label: 'Open' },
              { value: 'closed', label: 'Closed' },
              { value: 'all', label: 'All' }
            ]}
            value={(value.state as string) || 'open'}
            onChange={(e) => updateField('state', e.target.value)}
          />
        </div>

        {/* Assignee */}
        <div className="space-y-1.5">
          <Label htmlFor="gh-assignee">Assignee Filter</Label>
          <Input
            id="gh-assignee"
            value={(value.assignee as string) ?? ''}
            onChange={(e) => updateField('assignee', e.target.value)}
            placeholder="GitHub username (optional)"
          />
          <p className="text-xs text-muted-foreground">
            Only import issues assigned to this user
          </p>
        </div>

        {/* Labels */}
        <div className="space-y-1.5">
          <Label htmlFor="gh-labels">Labels Filter</Label>
          <Input
            id="gh-labels"
            value={(value.labels as string) ?? ''}
            onChange={(e) => updateField('labels', e.target.value)}
            placeholder="bug, feature (optional)"
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated labels to filter by
          </p>
        </div>
      </div>
    </>
  )
}
