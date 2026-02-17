import { Settings, Users, Server, Workflow, Wrench, X } from 'lucide-react'
import * as Tabs from '@radix-ui/react-tabs'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { GeneralSettings } from './tabs/GeneralSettings'
import { AgentsSettings } from './tabs/AgentsSettings'
import { ToolsMcpSettings } from './tabs/ToolsMcpSettings'
import { IntegrationsSettings } from './tabs/IntegrationsSettings'
import { AdvancedSettings } from './tabs/AdvancedSettings'

const ICON_MAP = {
  Settings,
  Users,
  Server,
  Workflow,
  Wrench
} as const

export function SettingsWorkspace() {
  const { settingsTab, setSettingsTab, closeModal } = useUIStore()

  const tabs = [
    { value: SettingsTab.GENERAL, label: 'General', iconName: 'Settings' },
    { value: SettingsTab.AGENTS, label: 'Agents', iconName: 'Users' },
    { value: SettingsTab.TOOLS_MCP, label: 'Tools & MCP', iconName: 'Server' },
    { value: SettingsTab.INTEGRATIONS, label: 'Task sources', iconName: 'Workflow' },
    { value: SettingsTab.ADVANCED, label: 'Advanced', iconName: 'Wrench' }
  ] as const

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-border bg-background flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your application preferences and integrations
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={closeModal} title="Close settings">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Settings Content */}
      <Tabs.Root
        value={settingsTab}
        onValueChange={(value) => setSettingsTab(value as typeof settingsTab)}
        className="flex-1 flex min-h-0"
        orientation="horizontal"
      >
        {/* Left Navigation Sidebar */}
        <Tabs.List className="shrink-0 w-60 border-r border-border bg-background/50 py-4 space-y-1 px-3">
          {tabs.map(({ value, label, iconName }) => {
            const Icon = ICON_MAP[iconName as keyof typeof ICON_MAP]
            return (
              <Tabs.Trigger
                key={value}
                value={value}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  'data-[state=active]:bg-accent data-[state=active]:text-foreground',
                  'data-[state=inactive]:text-muted-foreground',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </Tabs.Trigger>
            )
          })}
        </Tabs.List>

        {/* Right Content Area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-4xl mx-auto px-6 py-6">
            <Tabs.Content value={SettingsTab.GENERAL} className="focus-visible:outline-none space-y-6">
              <GeneralSettings />
            </Tabs.Content>

            <Tabs.Content value={SettingsTab.AGENTS} className="focus-visible:outline-none space-y-6">
              <AgentsSettings />
            </Tabs.Content>

            <Tabs.Content value={SettingsTab.TOOLS_MCP} className="focus-visible:outline-none space-y-6">
              <ToolsMcpSettings />
            </Tabs.Content>

            <Tabs.Content value={SettingsTab.INTEGRATIONS} className="focus-visible:outline-none space-y-6">
              <IntegrationsSettings />
            </Tabs.Content>

            <Tabs.Content value={SettingsTab.ADVANCED} className="focus-visible:outline-none space-y-6">
              <AdvancedSettings />
            </Tabs.Content>
          </div>
        </div>
      </Tabs.Root>
    </div>
  )
}
