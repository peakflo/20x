import { useState, useEffect, useCallback } from 'react'
import { Loader2, RefreshCw, CheckCircle2, XCircle, ExternalLink } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { pluginApi } from '@/lib/ipc-client'
import type { PluginFormProps } from './PluginFormProps'
import type { ConfigFieldOption } from '@/types'

type ConnectionStatus = 'idle' | 'testing' | 'connected' | 'error'

export function YouTrackConfigForm({ value, onChange }: PluginFormProps) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connectedUser, setConnectedUser] = useState<string | null>(null)

  // Dynamic options
  const [projects, setProjects] = useState<ConfigFieldOption[]>([])
  const [assignees, setAssignees] = useState<ConfigFieldOption[]>([])
  const [states, setStates] = useState<ConfigFieldOption[]>([])
  const [priorities, setPriorities] = useState<ConfigFieldOption[]>([])
  const [issueTypes, setIssueTypes] = useState<ConfigFieldOption[]>([])

  // Loading states
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadingFilters, setLoadingFilters] = useState(false)

  const updateField = useCallback(
    (key: string, val: unknown) => {
      onChange({ ...value, [key]: val })
    },
    [value, onChange]
  )

  const serverUrl = (value.server_url as string) || ''
  const apiToken = (value.api_token as string) || ''
  const selectedProject = (value.project as string) || ''
  const hasCredentials = serverUrl.trim() && apiToken.trim()

  // Test connection by trying to fetch projects
  const testConnection = useCallback(async () => {
    if (!hasCredentials) return

    setConnectionStatus('testing')
    setConnectionError(null)
    setConnectedUser(null)

    try {
      const options = await pluginApi.resolveOptions('youtrack', 'projects', value)
      if (options.length >= 0) {
        setConnectionStatus('connected')
        setProjects(options)
        // Try to get user info from projects response
        if (options.length > 0) {
          setConnectedUser(`${options.length} project${options.length !== 1 ? 's' : ''} accessible`)
        } else {
          setConnectedUser('Connected (no projects found)')
        }
      }
    } catch (err) {
      setConnectionStatus('error')
      const msg = err instanceof Error ? err.message : 'Connection failed'
      setConnectionError(msg)
    }
  }, [hasCredentials, value])

  // Auto-test connection when editing existing source with credentials
  useEffect(() => {
    if (hasCredentials && selectedProject && connectionStatus === 'idle') {
      testConnection()
    }
  }, []) // Only on mount

  // Fetch projects when connection is established
  const fetchProjects = useCallback(async () => {
    if (!hasCredentials) return

    setLoadingProjects(true)
    try {
      const options = await pluginApi.resolveOptions('youtrack', 'projects', value)
      setProjects(options)
    } catch (err) {
      console.error('Failed to fetch projects:', err)
      setProjects([])
    } finally {
      setLoadingProjects(false)
    }
  }, [hasCredentials, value])

  // Fetch filter options when project changes
  const fetchFilterOptions = useCallback(async () => {
    if (!hasCredentials || !selectedProject) return

    setLoadingFilters(true)
    try {
      const [userOpts, stateOpts, priorityOpts, typeOpts] = await Promise.all([
        pluginApi.resolveOptions('youtrack', 'users', value).catch(() => []),
        pluginApi.resolveOptions('youtrack', 'states', value).catch(() => []),
        pluginApi.resolveOptions('youtrack', 'priorities', value).catch(() => []),
        pluginApi.resolveOptions('youtrack', 'types', value).catch(() => [])
      ])
      setAssignees(userOpts)
      setStates(stateOpts)
      setPriorities(priorityOpts)
      setIssueTypes(typeOpts)
    } catch (err) {
      console.error('Failed to fetch filter options:', err)
    } finally {
      setLoadingFilters(false)
    }
  }, [hasCredentials, selectedProject, value])

  // Auto-fetch filter options when project changes
  useEffect(() => {
    if (connectionStatus === 'connected' && selectedProject) {
      fetchFilterOptions()
    }
  }, [selectedProject, connectionStatus])

  // Handle project change - clear dependent filters
  const handleProjectChange = (projectShortName: string) => {
    onChange({
      ...value,
      project: projectShortName,
      assignee: [],
      state: [],
      priority: [],
      issue_type: []
    })
  }

  return (
    <div className="space-y-3">
      {/* Server URL */}
      <div className="space-y-1.5">
        <Label htmlFor="yt-server-url">Server URL</Label>
        <Input
          id="yt-server-url"
          type="text"
          value={serverUrl}
          onChange={(e) => {
            updateField('server_url', e.target.value)
            if (connectionStatus !== 'idle') {
              setConnectionStatus('idle')
              setConnectionError(null)
              setConnectedUser(null)
            }
          }}
          placeholder="https://youtrack.your-company.com"
          required
        />
        <p className="text-xs text-muted-foreground">
          Your YouTrack instance URL (Cloud or self-hosted)
        </p>
      </div>

      {/* API Token */}
      <div className="space-y-1.5">
        <Label htmlFor="yt-api-token">Permanent Token</Label>
        <Input
          id="yt-api-token"
          type="password"
          value={apiToken}
          onChange={(e) => {
            updateField('api_token', e.target.value)
            if (connectionStatus !== 'idle') {
              setConnectionStatus('idle')
              setConnectionError(null)
              setConnectedUser(null)
            }
          }}
          placeholder="perm:..."
          required
        />
        <p className="text-xs text-muted-foreground">
          Generate at{' '}
          <button
            type="button"
            onClick={() => {
              const url = serverUrl.trim()
                ? `${serverUrl.replace(/\/$/, '')}/users/me`
                : 'https://www.jetbrains.com/help/youtrack/server/manage-permanent-token.html'
              window.electronAPI.shell.openExternal(url)
            }}
            className="text-primary hover:underline inline-flex items-center gap-0.5"
          >
            Profile &gt; Account Security &gt; New Token
            <ExternalLink className="h-3 w-3" />
          </button>
          {' '}(scope: YouTrack)
        </p>
      </div>

      {/* Test Connection Button */}
      <div className="space-y-1.5">
        <Button
          type="button"
          variant={connectionStatus === 'connected' ? 'outline' : 'default'}
          onClick={testConnection}
          disabled={!hasCredentials || connectionStatus === 'testing'}
          className="w-full"
        >
          {connectionStatus === 'testing' && (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          )}
          {connectionStatus === 'connected' && (
            <CheckCircle2 className="h-4 w-4 text-green-500 mr-2" />
          )}
          {connectionStatus === 'error' && (
            <XCircle className="h-4 w-4 text-destructive mr-2" />
          )}
          {connectionStatus === 'idle' && 'Test Connection'}
          {connectionStatus === 'testing' && 'Testing...'}
          {connectionStatus === 'connected' && 'Connected'}
          {connectionStatus === 'error' && 'Connection Failed — Retry'}
        </Button>

        {connectionStatus === 'connected' && connectedUser && (
          <p className="text-xs text-green-500 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            {connectedUser}
          </p>
        )}
        {connectionStatus === 'error' && connectionError && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <XCircle className="h-3 w-3" />
            {connectionError}
          </p>
        )}

        {!hasCredentials && (
          <p className="text-xs text-muted-foreground">
            Enter server URL and token above to test the connection
          </p>
        )}
      </div>

      {/* Project Selector - only shown after connection */}
      {connectionStatus === 'connected' && (
        <>
          <div className="pt-2 border-t border-border">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="yt-project">Project</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={fetchProjects}
                  disabled={loadingProjects}
                  className="h-6 px-2 text-xs"
                >
                  {loadingProjects ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                </Button>
              </div>
              <select
                id="yt-project"
                value={selectedProject}
                onChange={(e) => handleProjectChange(e.target.value)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
                disabled={loadingProjects}
                required
              >
                <option value="">
                  {loadingProjects ? 'Loading projects...' : 'Select a project...'}
                </option>
                {projects.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Select the YouTrack project to import issues from
              </p>
            </div>
          </div>

          {/* Filter Options - only shown after project selection */}
          {selectedProject && (
            <div className="space-y-3 pt-2 border-t border-border">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Filters (Optional)</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={fetchFilterOptions}
                  disabled={loadingFilters}
                  className="h-6 px-2 text-xs"
                >
                  {loadingFilters ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="h-3 w-3" /> Refresh
                    </span>
                  )}
                </Button>
              </div>

              {/* Assignee Filter */}
              <MultiSelectField
                label="Assignee"
                options={assignees}
                selected={(value.assignee as string[]) || []}
                onChange={(vals) => updateField('assignee', vals)}
                loading={loadingFilters}
                placeholder="All assignees"
              />

              {/* State Filter */}
              <MultiSelectField
                label="State"
                options={states}
                selected={(value.state as string[]) || []}
                onChange={(vals) => updateField('state', vals)}
                loading={loadingFilters}
                placeholder="All states"
              />

              {/* Priority Filter */}
              <MultiSelectField
                label="Priority"
                options={priorities}
                selected={(value.priority as string[]) || []}
                onChange={(vals) => updateField('priority', vals)}
                loading={loadingFilters}
                placeholder="All priorities"
              />

              {/* Issue Type Filter */}
              <MultiSelectField
                label="Type"
                options={issueTypes}
                selected={(value.issue_type as string[]) || []}
                onChange={(vals) => updateField('issue_type', vals)}
                loading={loadingFilters}
                placeholder="All types"
              />

              {/* Custom YQL Query */}
              <div className="space-y-1.5">
                <Label htmlFor="yt-custom-query">Additional Query (YQL)</Label>
                <Input
                  id="yt-custom-query"
                  type="text"
                  value={(value.custom_query as string) ?? ''}
                  onChange={(e) => updateField('custom_query', e.target.value)}
                  placeholder="#Unresolved sort by: updated desc"
                />
                <p className="text-xs text-muted-foreground">
                  Optional{' '}
                  <button
                    type="button"
                    onClick={() =>
                      window.electronAPI.shell.openExternal(
                        'https://www.jetbrains.com/help/youtrack/server/search-for-issues.html'
                      )
                    }
                    className="text-primary hover:underline"
                  >
                    YouTrack Query Language
                  </button>
                  {' '}expression appended to the filters above
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Multi-select checkbox field component ────────────────────

interface MultiSelectFieldProps {
  label: string
  options: ConfigFieldOption[]
  selected: string[]
  onChange: (values: string[]) => void
  loading?: boolean
  placeholder?: string
}

function MultiSelectField({
  label,
  options,
  selected,
  onChange,
  loading,
  placeholder
}: MultiSelectFieldProps) {
  const toggleValue = (val: string) => {
    const next = selected.includes(val)
      ? selected.filter((v) => v !== val)
      : [...selected, val]
    onChange(next)
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {loading ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading...
            </span>
          ) : selected.length > 0 ? (
            `${selected.length} selected`
          ) : (
            placeholder || 'None selected'
          )}
        </span>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      <div className="max-h-36 overflow-y-auto rounded-md border border-input p-1.5 space-y-0.5">
        {loading && options.length === 0 && (
          <div className="flex items-center justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && options.length === 0 && (
          <p className="text-xs text-muted-foreground px-2 py-1">No options available</p>
        )}
        {options.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-2 text-sm cursor-pointer rounded px-2 py-1 hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={selected.includes(opt.value)}
              onChange={() => toggleValue(opt.value)}
              className="rounded border-input"
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  )
}
