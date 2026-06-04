import { useState, useEffect, useMemo } from 'react'
import {
  Search,
  Plus,
  Check,
  ExternalLink,
  Database,
  CreditCard,
  Github,
  Server,
  FileText,
  Table,
  Calendar,
  Phone,
  MessageSquare,
  Globe,
  Mail,
  BarChart3,
  Loader2
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { SettingsSection } from '../SettingsSection'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { enterpriseApi } from '@/lib/ipc-client'

// ── Connector catalog ──────────────────────────────────────────────────

interface ConnectorType {
  id: string
  name: string
  description: string
  iconName: string
  category: string
}

const CONNECTOR_CATALOG: ConnectorType[] = [
  // Database
  { id: 'postgres', name: 'PostgreSQL', description: 'Connect to PostgreSQL database', iconName: 'Database', category: 'Database' },
  { id: 'mysql', name: 'MySQL', description: 'Connect to MySQL database', iconName: 'Database', category: 'Database' },
  { id: 'mongodb', name: 'MongoDB', description: 'Connect to MongoDB database', iconName: 'Database', category: 'Database' },
  { id: 'google-firestore', name: 'Firestore', description: 'Connect to Google Firestore for NoSQL database operations', iconName: 'Database', category: 'Database' },
  // Payment
  { id: 'stripe', name: 'Stripe', description: 'Connect to Stripe payments', iconName: 'CreditCard', category: 'Payment' },
  // AI
  { id: 'mcp', name: 'MCP Server', description: 'Connect to Model Context Protocol server', iconName: 'Server', category: 'AI' },
  // Storage
  { id: 'google-drive', name: 'Google Drive', description: 'Connect to Google Drive for file storage and sharing', iconName: 'FileText', category: 'Storage' },
  // Productivity
  { id: 'google-sheet', name: 'Google Sheets', description: 'Connect to Google Sheets', iconName: 'Table', category: 'Productivity' },
  { id: 'google-calendar', name: 'Google Calendar', description: 'Connect to Google Calendar for scheduling and events', iconName: 'Calendar', category: 'Productivity' },
  { id: 'notion-mcp', name: 'Notion MCP', description: 'Connect to Notion via MCP for AI-powered workspace access', iconName: 'FileText', category: 'Productivity' },
  { id: 'notion', name: 'Notion', description: 'Connect to Notion REST API for database queries and task sync', iconName: 'FileText', category: 'Productivity' },
  // Communication
  { id: 'google-mail', name: 'Gmail', description: 'Connect to Gmail for email and calendar', iconName: 'Mail', category: 'Communication' },
  { id: 'slack-user', name: 'Slack', description: 'Connect to Slack with user-level OAuth to post messages as yourself', iconName: 'MessageSquare', category: 'Communication' },
  { id: 'outlook', name: 'Outlook', description: 'Connect to Outlook for email and calendar', iconName: 'Mail', category: 'Communication' },
  { id: 'tldv', name: 'TLDV', description: 'Connect to TLDV for meeting recording and transcription', iconName: 'MessageSquare', category: 'Communication' },
  { id: 'whatsapp-business', name: 'WhatsApp Business', description: 'Connect to WhatsApp Business for messaging', iconName: 'MessageSquare', category: 'Communication' },
  // Developer Tools
  { id: 'github', name: 'GitHub', description: 'Connect to GitHub and reuse a single token across workflows', iconName: 'Github', category: 'Developer Tools' },
  // CRM
  { id: 'hubspot', name: 'HubSpot', description: 'Connect to HubSpot for CRM, marketing, and sales automation', iconName: 'Globe', category: 'CRM' },
  { id: 'salesforce', name: 'Salesforce', description: 'Connect to Salesforce via pfMCP (OAuth with Nango)', iconName: 'Globe', category: 'CRM' },
  // Sales
  { id: 'apollo', name: 'Apollo', description: 'Connect to Apollo for sales intelligence and prospecting', iconName: 'Globe', category: 'Sales' },
  // ERP
  { id: 'netsuite-tba', name: 'NetSuite', description: 'Connect to NetSuite ERP via pfMCP (OAuth with Nango)', iconName: 'Globe', category: 'ERP' },
  // Accounting
  { id: 'peakflo', name: 'Peakflo', description: 'Connect to Peakflo APIs', iconName: 'CreditCard', category: 'Accounting' },
  { id: 'xero', name: 'Xero', description: 'Connect to Xero for accounting, invoicing, and payroll management', iconName: 'CreditCard', category: 'Accounting' },
  // Analytics
  { id: 'google-search-console', name: 'Google Search Console', description: 'Connect to Google Search Console for search performance insights', iconName: 'BarChart3', category: 'Analytics' },
  { id: 'google-analytics', name: 'Google Analytics 4', description: 'Connect to Google Analytics 4 for traffic and user behavior data', iconName: 'BarChart3', category: 'Analytics' },
  // Phone
  { id: 'peakflo-phone', name: 'Phone Number by Peakflo', description: 'Get a Peakflo phone number', iconName: 'Phone', category: 'Phone' },
  { id: 'twilio-phone', name: 'Import Twilio Number', description: 'Import an existing Twilio phone number', iconName: 'MessageSquare', category: 'Phone' },
  { id: 'telnyx-phone', name: 'Import Telnyx Number', description: 'Import an existing Telnyx phone number', iconName: 'Phone', category: 'Phone' },
  { id: 'sip-trunk', name: 'BYO SIP Trunk', description: 'Bring your own SIP trunk number with custom credentials', iconName: 'Phone', category: 'Phone' }
]

const ICON_MAP: Record<string, React.ElementType> = {
  Database,
  CreditCard,
  Github,
  Server,
  FileText,
  Table,
  Calendar,
  Phone,
  MessageSquare,
  Globe,
  Mail,
  BarChart3
}

// ── Helpers ────────────────────────────────────────────────────────────

interface ConnectedIntegration {
  id: string
  type: string
  name: string
}

/**
 * Derive the workflo-builder frontend URL from the API URL.
 * Mirrors the logic in main/ipc-handlers.ts.
 */
async function getWorkfloFrontendUrl(): Promise<string> {
  try {
    const apiUrl = await enterpriseApi.getApiUrl()
    const parsed = new URL(apiUrl)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      parsed.port = '4000'
      return parsed.origin
    }
    // Production: api.X.ai → app.X.ai  or  stage-api.X.ai → stage-app.X.ai
    parsed.hostname = parsed.hostname.replace('-api.', '-app.').replace(/^api\./, 'app.')
    return parsed.origin
  } catch {
    return 'https://app.peakflo.ai'
  }
}

// ── Component ──────────────────────────────────────────────────────────

export function ConnectorsSettings() {
  const { isAuthenticated, currentTenant } = useEnterpriseStore()
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [connectedIntegrations, setConnectedIntegrations] = useState<ConnectedIntegration[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [frontendUrl, setFrontendUrl] = useState<string | null>(null)

  // Fetch connected integrations from workflo API
  useEffect(() => {
    if (!isAuthenticated || !currentTenant) return

    const load = async () => {
      setIsLoading(true)
      try {
        const result = await enterpriseApi.apiRequest('GET', '/api/integrations') as ConnectedIntegration[]
        setConnectedIntegrations(Array.isArray(result) ? result : [])
      } catch (err) {
        console.error('[connectors] Failed to fetch integrations:', err)
        setConnectedIntegrations([])
      } finally {
        setIsLoading(false)
      }
    }

    load()
  }, [isAuthenticated, currentTenant?.id])

  // Resolve frontend URL once
  useEffect(() => {
    if (isAuthenticated) {
      getWorkfloFrontendUrl().then(setFrontendUrl)
    }
  }, [isAuthenticated])

  // Connection counts per type
  const connectionCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const integration of connectedIntegrations) {
      counts[integration.type] = (counts[integration.type] || 0) + 1
    }
    return counts
  }, [connectedIntegrations])

  // Unique categories
  const categories = useMemo(() => {
    const cats = new Set<string>()
    CONNECTOR_CATALOG.forEach((c) => cats.add(c.category))
    return Array.from(cats).sort()
  }, [])

  // Filtered + grouped
  const filteredConnectors = useMemo(() => {
    return CONNECTOR_CATALOG.filter((connector) => {
      const q = search.toLowerCase()
      const matchesSearch =
        !q ||
        connector.name.toLowerCase().includes(q) ||
        connector.description.toLowerCase().includes(q) ||
        connector.category.toLowerCase().includes(q)
      const matchesCategory = !selectedCategory || connector.category === selectedCategory
      return matchesSearch && matchesCategory
    })
  }, [search, selectedCategory])

  const groupedConnectors = useMemo(() => {
    const groups: Record<string, ConnectorType[]> = {}
    for (const c of filteredConnectors) {
      if (!groups[c.category]) groups[c.category] = []
      groups[c.category].push(c)
    }
    return groups
  }, [filteredConnectors])

  const handleConnect = async (connectorId: string) => {
    const url = frontendUrl ?? 'https://app.peakflo.ai'
    const target = `${url}/settings/integrations/new/${connectorId}`
    // Open in the user's default browser
    window.open(target, '_blank')
  }

  const handleManageIntegrations = () => {
    const url = frontendUrl ?? 'https://app.peakflo.ai'
    window.open(`${url}/settings/integrations`, '_blank')
  }

  // ── Not connected state ──────────────────────────────────────────
  if (!isAuthenticated || !currentTenant) {
    return (
      <SettingsSection
        title="Connectors"
        description="Browse and connect external services to your workflows"
      >
        <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
          <p className="text-sm text-muted-foreground mb-3">
            Sign in to 20x Cloud to manage connectors
          </p>
        </div>
      </SettingsSection>
    )
  }

  // ── Connected state ──────────────────────────────────────────────
  const totalConnected = connectedIntegrations.length
  const connectedTypes = new Set(connectedIntegrations.map((i) => i.type)).size

  return (
    <>
      <SettingsSection
        title="Connectors"
        description="Browse and connect external services to your workflows"
      >
        {/* Summary + manage link */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {isLoading
              ? 'Loading...'
              : `${totalConnected} connection${totalConnected !== 1 ? 's' : ''} across ${connectedTypes} service${connectedTypes !== 1 ? 's' : ''}`}
          </p>
          <Button size="sm" variant="secondary" onClick={handleManageIntegrations}>
            Manage in Workflo
            <ExternalLink className="h-3 w-3 ml-1.5" />
          </Button>
        </div>

        {/* Search + category filter */}
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search connectors..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setSelectedCategory(null)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                selectedCategory === null
                  ? 'bg-foreground text-background'
                  : 'bg-secondary text-secondary-foreground hover:bg-accent'
              }`}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  selectedCategory === cat
                    ? 'bg-foreground text-background'
                    : 'bg-secondary text-secondary-foreground hover:bg-accent'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </SettingsSection>

      {/* Connector grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedConnectors)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([category, connectors]) => (
              <div key={category}>
                <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  {category}
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {connectors.map((connector) => {
                    const Icon = ICON_MAP[connector.iconName] ?? Globe
                    const count = connectionCounts[connector.id] || 0
                    const isConnected = count > 0

                    return (
                      <div
                        key={connector.id}
                        className="group rounded-lg border border-border bg-card overflow-hidden hover:border-primary/30 transition-colors"
                      >
                        <div className="flex items-center gap-3 px-3 py-2.5">
                          <div
                            className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${
                              isConnected ? 'bg-primary/10' : 'bg-muted'
                            }`}
                          >
                            <Icon
                              className={`h-4 w-4 ${
                                isConnected ? 'text-primary' : 'text-muted-foreground'
                              }`}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-sm truncate">{connector.name}</span>
                              {isConnected && (
                                <Badge variant="green" className="text-[10px] px-1.5 py-0 h-4 border-0">
                                  <Check className="h-2.5 w-2.5 mr-0.5" />
                                  {count}
                                </Badge>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {connector.description}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 h-7 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => handleConnect(connector.id)}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            {isConnected ? 'Add' : 'Connect'}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}

          {filteredConnectors.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">
                No connectors found matching your search.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  )
}
