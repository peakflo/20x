/** Types shared by the data export/import handlers and the settings UI. */

export type DataCategory =
  | 'tasks'
  | 'transcripts'
  | 'agents'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'settings'
  | 'secrets'

export const DATA_CATEGORIES: readonly DataCategory[] = [
  'tasks',
  'transcripts',
  'agents',
  'skills',
  'mcp',
  'plugins',
  'settings',
  'secrets'
]

export const DATA_CATEGORY_LABELS: Record<DataCategory, { label: string; hint: string }> = {
  tasks: { label: 'Tasks', hint: 'Tasks, subtasks, heartbeat logs and attachments' },
  transcripts: { label: 'Agent transcripts', hint: 'Saved conversation history for each task' },
  agents: { label: 'Agents', hint: 'Agent setups, without API keys' },
  skills: { label: 'Skills', hint: 'Skill instructions and usage stats' },
  mcp: { label: 'MCP servers and task sources', hint: 'Without tokens or passwords' },
  plugins: { label: 'Plugins', hint: 'Marketplaces and installed plugins' },
  settings: { label: 'Preferences', hint: 'Theme, heartbeat and workspace settings' },
  secrets: { label: 'Secret names', hint: 'Names only. Values are never exported.' }
}

export interface BundleManifest {
  format: '20x-export'
  version: number
  appVersion: string
  schemaVersion: number
  exportedAt: string
  categories: DataCategory[]
  /** Row count per table, plus `attachments` for the number of files. */
  counts: Record<string, number>
}

export type DataExportResult =
  | { canceled: true }
  | { canceled: false; path: string; manifest: BundleManifest }

export interface DataImportPreview {
  fileName: string
  manifest: BundleManifest
  /** Rows per category found in the file. */
  categories: Partial<Record<DataCategory, number>>
}

export interface TableImportStats {
  inserted: number
  skipped: number
  failed: number
}

export interface DataImportResult {
  tables: Record<string, TableImportStats>
  attachments: number
  /** Env var names of imported secrets that still need a value. */
  secretsNeedingValues: string[]
  /** Path of the database backup taken before the import. */
  backupPath: string | null
}
