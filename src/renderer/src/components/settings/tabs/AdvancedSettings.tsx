import { useState, useEffect } from 'react'
import { CheckCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Select } from '@/components/ui/Select'
import { SettingsSection } from '../SettingsSection'
import { useSettingsStore } from '@/stores/settings-store'
import { settingsApi } from '@/lib/ipc-client'
import { subscribe } from '@/lib/shared-ipc-listeners'
import { WORKTREE_BRANCH_MODE_KEY, WORKTREE_BRANCH_PREFIX_KEY, WORKTREE_BRANCH_TEMPLATE_KEY, type WorktreeBranchMode } from '@shared/worktree-branch-name'
import { BrowserSessionsSettings } from './BrowserSessionsSettings'

export function AdvancedSettings() {
  const { githubOrg, ghCliStatus, setGithubOrg, checkGhCli, startGhAuth } = useSettingsStore()
  const [orgInput, setOrgInput] = useState(githubOrg || '')
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [deviceCode, setDeviceCode] = useState('')
  const [branchMode, setBranchMode] = useState<WorktreeBranchMode>('prefix')
  const [branchPrefix, setBranchPrefix] = useState('task')
  const [branchTemplate, setBranchTemplate] = useState('{type}/{slug}-{shortId}')
  const [branchSaved, setBranchSaved] = useState(false)

  // API Keys
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [googleKey, setGoogleKey] = useState('')

  useEffect(() => {
    return subscribe<string>(
      'github:deviceCode',
      (cb) => window.electronAPI.onGithubDeviceCode(cb),
      (code) => setDeviceCode(code)
    )
  }, [])

  useEffect(() => {
    checkGhCli()
    if (githubOrg) setOrgInput(githubOrg)

    // Load API keys
    const loadKeys = async () => {
      const keys = await settingsApi.getAll()
      setAnthropicKey(keys.anthropic_api_key || '')
      setOpenaiKey(keys.openai_api_key || '')
      setGoogleKey(keys.google_api_key || '')
      const mode = keys[WORKTREE_BRANCH_MODE_KEY]
      if (mode === 'prefix' || mode === 'type-title' || mode === 'ai' || mode === 'template') setBranchMode(mode)
      setBranchPrefix(keys[WORKTREE_BRANCH_PREFIX_KEY] ?? 'task')
      setBranchTemplate(keys[WORKTREE_BRANCH_TEMPLATE_KEY] ?? '{type}/{slug}-{shortId}')
    }
    loadKeys()
  }, [githubOrg])

  const saveApiKey = async (key: string, value: string) => {
    if (value.trim()) {
      await settingsApi.set(key, value.trim())
    } else {
      // Optionally delete the key if empty
      await settingsApi.set(key, '')
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Worktree branch names"
        description="Choose names for newly created task branches. Existing worktrees keep their branches."
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="branch-mode">Naming rule</Label>
            <Select id="branch-mode" value={branchMode} onChange={(event) => { setBranchMode(event.target.value as WorktreeBranchMode); setBranchSaved(false) }} options={[
              { value: 'prefix', label: 'Prefix + task id' },
              { value: 'type-title', label: 'Type + title slug' },
              { value: 'ai', label: 'AI-picked' },
              { value: 'template', label: 'Custom template' }
            ]} />
          </div>
          {branchMode === 'prefix' && <div className="space-y-1.5">
            <Label htmlFor="branch-prefix">Prefix</Label>
            <Input id="branch-prefix" value={branchPrefix} onChange={(event) => { setBranchPrefix(event.target.value); setBranchSaved(false) }} placeholder="task" />
            <p className="text-xs text-muted-foreground">Example: task/task-123</p>
          </div>}
          {branchMode === 'template' && <div className="space-y-1.5">
            <Label htmlFor="branch-template">Template</Label>
            <Input id="branch-template" value={branchTemplate} onChange={(event) => { setBranchTemplate(event.target.value); setBranchSaved(false) }} placeholder="{type}/{slug}-{shortId}" />
            <p className="text-xs text-muted-foreground">Use {'{type}'}, {'{slug}'}, {'{id}'}, {'{shortId}'}, and {'{date}'}.</p>
          </div>}
          {branchMode === 'ai' && <p className="text-xs text-muted-foreground">Sends the task title and description to OpenAI using your stored API key. If unavailable or slow, uses type + title slug.</p>}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={async () => {
              await settingsApi.set(WORKTREE_BRANCH_MODE_KEY, branchMode)
              await settingsApi.set(WORKTREE_BRANCH_PREFIX_KEY, branchPrefix)
              await settingsApi.set(WORKTREE_BRANCH_TEMPLATE_KEY, branchTemplate)
              setBranchSaved(true)
            }}>Save</Button>
            {branchSaved && <span className="text-xs text-muted-foreground">Saved</span>}
          </div>
        </div>
      </SettingsSection>
      <BrowserSessionsSettings />
      <SettingsSection
        title="GitHub Integration"
        description="Configure GitHub CLI for repository operations and worktree management"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs">
            {ghCliStatus?.authenticated ? (
              <span className="flex items-center gap-1.5 text-foreground">
                <CheckCircle className="h-3.5 w-3.5 text-primary" />
                Authenticated{ghCliStatus.username ? ` as ${ghCliStatus.username}` : ''}
              </span>
            ) : ghCliStatus?.installed ? (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">gh CLI installed but not authenticated</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    setIsAuthenticating(true)
                    setDeviceCode('')
                    try {
                      await startGhAuth()
                    } catch (error) {
                      console.error('GitHub auth failed:', error)
                    } finally {
                      setIsAuthenticating(false)
                      setDeviceCode('')
                    }
                  }}
                  disabled={isAuthenticating}
                >
                  {isAuthenticating && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                  Authenticate
                </Button>

                {deviceCode && (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">Enter this code in your browser:</p>
                    <code className="block text-lg font-mono font-bold bg-muted px-3 py-2 rounded text-center">
                      {deviceCode}
                    </code>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Waiting for authorization...
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">gh CLI not installed</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={orgInput}
              onChange={(e) => setOrgInput(e.target.value)}
              placeholder="GitHub org name"
              className="flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!orgInput.trim() || orgInput.trim() === githubOrg}
              onClick={() => setGithubOrg(orgInput.trim())}
            >
              Save
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="API Keys"
        description="Configure API keys for AI providers (stored securely locally)"
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="anthropic-key">Anthropic API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                id="anthropic-key"
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-..."
                className="flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveApiKey('anthropic_api_key', anthropicKey)}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Used by Claude Code agents
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="openai-key">OpenAI API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                id="openai-key"
                type="password"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder="sk-..."
                className="flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveApiKey('openai_api_key', openaiKey)}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Used by Codex agents
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="google-key">Google API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                id="google-key"
                type="password"
                value={googleKey}
                onChange={(e) => setGoogleKey(e.target.value)}
                placeholder="AI..."
                className="flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveApiKey('google_api_key', googleKey)}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              For Gemini models (future support)
            </p>
          </div>
        </div>
      </SettingsSection>
    </div>
  )
}
