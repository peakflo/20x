import { useEffect, useMemo, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { agentApi, settingsApi } from '@/lib/ipc-client'
import { useMastermindStore } from '@/stores/mastermind-store'
import { useUIStore } from '@/stores/ui-store'
import { PEAKO_SETTINGS_CHANGED_EVENT } from '@/components/peako/PeakoBridge'
import { CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS, CodingAgentType, SettingsTab, type Agent } from '@/types'
import {
  MASTERMIND_AGENT_SETTING,
  PEAKO_DEFAULT_NAME,
  PEAKO_NAME_MAX_LENGTH,
  PEAKO_SETTING_KEYS,
  normalizePeakoName
} from '@shared/peako'

/** The agent made for Peako when its model was changed, so other agents stay as they are. */
const PEAKO_OWN_AGENT_SETTING = 'peako_own_agent_id'

function knownModels(agent: Agent | undefined, agents: Agent[]): string[] {
  const codingAgent = agent?.config.coding_agent
  const preset =
    codingAgent === CodingAgentType.CLAUDE_CODE
      ? CLAUDE_MODELS
      : codingAgent === CodingAgentType.CODEX
        ? CODEX_MODELS
        : codingAgent === CodingAgentType.CURSOR
          ? CURSOR_MODELS
          : []
  const used = agents
    .filter((other) => other.config.coding_agent === codingAgent && other.config.model)
    .map((other) => other.config.model as string)
  return [...new Set([...preset.map((model) => model.id as string), ...used])]
}

export function PeakoSettings() {
  const agents = useMastermindStore((s) => s.agents)
  const selectedAgentId = useMastermindStore((s) => s.selectedAgentId)
  const changeAgent = useMastermindStore((s) => s.changeAgent)
  const [enabled, setEnabled] = useState(true)
  const [name, setName] = useState(PEAKO_DEFAULT_NAME)
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const selected = agents.find((agent) => agent.id === selectedAgentId)
  const modelOptions = useMemo(() => knownModels(selected, agents), [selected, agents])

  useEffect(() => {
    void window.electronAPI.peako.getEnabled().then(setEnabled)
    void settingsApi.get(PEAKO_SETTING_KEYS.name).then((value) => setName(normalizePeakoName(value)))
    const refresh = () => {
      void window.electronAPI.peako.getEnabled().then(setEnabled)
      void settingsApi.get(PEAKO_SETTING_KEYS.name).then((value) => setName(normalizePeakoName(value)))
    }
    window.addEventListener(PEAKO_SETTINGS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(PEAKO_SETTINGS_CHANGED_EVENT, refresh)
  }, [])

  useEffect(() => {
    setModel(selected?.config.model ?? '')
  }, [selected?.id, selected?.config.model])

  const notifyBridge = () => window.dispatchEvent(new CustomEvent(PEAKO_SETTINGS_CHANGED_EVENT))

  const handleEnabled = async (checked: boolean) => {
    setEnabled(await window.electronAPI.peako.setEnabled(checked))
    notifyBridge()
  }

  const saveName = async () => {
    const normalized = normalizePeakoName(name)
    setName(normalized)
    await settingsApi.set(PEAKO_SETTING_KEYS.name, normalized)
    notifyBridge()
  }

  const selectAgent = async (agentId: string) => {
    if (changeAgent) await changeAgent(agentId)
    else {
      await settingsApi.set(MASTERMIND_AGENT_SETTING, agentId)
      useMastermindStore.getState().setSelectedAgentId(agentId)
    }
  }

  /**
   * Changing the model never edits an agent your tasks use. Peako keeps one
   * agent of its own: the first change creates it as a copy of the chosen
   * agent, and every later change rewrites that same agent, so copies never
   * pile up.
   */
  const saveModel = async () => {
    const nextModel = model.trim()
    if (!selected || !nextModel || nextModel === selected.config.model) return
    setSaving(true)
    setMessage(null)
    try {
      const ownId = await settingsApi.get(PEAKO_OWN_AGENT_SETTING)
      const own = agents.find((agent) => agent.id === ownId)
      const fields = {
        name: `${normalizePeakoName(name)}'s brain`,
        server_url: selected.server_url,
        config: { ...selected.config, model: nextModel }
      }
      let targetId: string
      if (own) {
        await agentApi.update(own.id, fields)
        targetId = own.id
      } else {
        const created = await agentApi.create({ ...fields, is_default: false })
        await settingsApi.set(PEAKO_OWN_AGENT_SETTING, created.id)
        targetId = created.id
      }
      useMastermindStore.getState().setAgents(await agentApi.getAll())
      // Restarts the conversation so the next message uses the new model.
      await selectAgent(targetId)
      setMessage(`Now thinking with ${nextModel}.`)
    } catch (error) {
      setMessage(`Could not change the model: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const openAgents = () => useUIStore.getState().setSettingsTab(SettingsTab.AGENTS)

  return (
    <SettingsSection
      title={`${name} on your desktop`}
      description="Your assistant for everything in 20x. It floats above other windows; click it to chat, hold a conversation by voice, or drag it anywhere."
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="peako-enabled">Show {name} on the desktop</Label>
            <p className="text-xs text-muted-foreground">You can also hide it from its right-click menu.</p>
          </div>
          <Switch id="peako-enabled" checked={enabled} onCheckedChange={handleEnabled} />
        </div>

        <div className="grid gap-1.5 py-2 border-b border-border">
          <Label htmlFor="peako-name">Name</Label>
          <div className="flex gap-2">
            <Input
              id="peako-name"
              value={name}
              maxLength={PEAKO_NAME_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveName()
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">You can also click the name in its chat to rename it.</p>
        </div>

        <div className="grid gap-1.5 py-2 border-b border-border">
          <Label htmlFor="peako-agent">Brain</Label>
          <Select
            id="peako-agent"
            value={selectedAgentId ?? ''}
            disabled={agents.length === 0}
            onChange={(event) => void selectAgent(event.target.value)}
            options={
              agents.length === 0
                ? [{ value: '', label: 'No agents yet' }]
                : agents.map((agent) => ({
                    value: agent.id,
                    label: agent.config.model ? `${agent.name} · ${agent.config.model}` : agent.name
                  }))
            }
          />
          <p className="text-xs text-muted-foreground">
            The agent {name} thinks with, on the desktop and in its side panel. Switching starts a new conversation.
          </p>
        </div>

        <div className="grid gap-1.5 py-2">
          <Label htmlFor="peako-model">Model</Label>
          <div className="flex gap-2">
            <Input
              id="peako-model"
              list="peako-model-options"
              value={model}
              placeholder="Pick or type a model ID"
              disabled={!selected || saving}
              onChange={(event) => setModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveModel()
              }}
            />
            <datalist id="peako-model-options">
              {modelOptions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            <Button
              variant="outline"
              size="sm"
              disabled={!selected || saving || !model.trim() || model.trim() === selected?.config.model}
              onClick={() => void saveModel()}
            >
              {saving ? 'Saving…' : 'Use model'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Changing it gives {name} one agent of its own (shown in Agents as “{name}&apos;s brain”), so your other agents keep their models.{' '}
            <button type="button" className="text-primary hover:underline" onClick={openAgents}>
              More agent options
            </button>
          </p>
          {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
        </div>
      </div>
    </SettingsSection>
  )
}
