import { useState, useEffect, useCallback } from 'react'
import { Loader2, Plus, X, Search, RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { pluginApi } from '@/lib/ipc-client'
import type { ConfigFieldOption } from '@/types'
import type { PluginFormProps } from './PluginFormProps'

// Shared constants from the plugin (these values match NotionPropertyType enum and maps)
// Duplicated here to avoid importing from main process code.
const ENUM_PROPERTY_TYPES = new Set(['status', 'select', 'multi_select', 'people'])

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  status: 'Status',
  select: 'Select',
  multi_select: 'Multi-select',
  title: 'Title',
  rich_text: 'Text',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date'
}

// ── Types ────────────────────────────────────────────────────

interface NotionPropertyOption {
  value: string
  label: string
}

interface NotionPropertyInfo {
  name: string
  type: string
  options?: NotionPropertyOption[]
}

interface NotionFilterRow {
  property: string
  type: string
  values: string[]
}

// ── Main Form ────────────────────────────────────────────────

export function NotionConfigForm({ value, onChange, sourceId }: PluginFormProps) {
  const [dataSources, setDataSources] = useState<ConfigFieldOption[]>([])
  const [dbProperties, setDbProperties] = useState<NotionPropertyInfo[]>([])
  const [loadingDataSources, setLoadingDataSources] = useState(false)
  const [loadingProps, setLoadingProps] = useState(false)
  const [dataSourcesError, setDataSourcesError] = useState<string | null>(null)
  const [dataSourceRefreshKey, setDataSourceRefreshKey] = useState(0)

  const updateField = useCallback(
    (key: string, val: unknown) => onChange({ ...value, [key]: val }),
    [value, onChange]
  )

  // Fetch data sources when token is present
  useEffect(() => {
    const token = value.api_token as string
    if (!token) {
      setDataSources([])
      setDataSourcesError(null)
      return
    }
    setLoadingDataSources(true)
    setDataSourcesError(null)
    pluginApi
      .resolveOptions('notion', 'data_sources', value, undefined, sourceId)
      .then(setDataSources)
      .catch((error: unknown) => {
        setDataSources([])
        setDataSourcesError(
          error instanceof Error ? error.message : 'Failed to load data sources'
        )
      })
      .finally(() => setLoadingDataSources(false))
  }, [value.api_token, sourceId, dataSourceRefreshKey])

  // Fetch properties when the data source changes
  useEffect(() => {
    const dataSourceId = value.data_source_id as string
    if (!dataSourceId || !value.api_token) {
      setDbProperties([])
      return
    }
    setLoadingProps(true)
    pluginApi
      .resolveOptions('notion', 'data_source_properties', value, undefined, sourceId)
      .then((opts) => {
        setDbProperties(opts.map((o) => JSON.parse(o.value) as NotionPropertyInfo))
      })
      .catch(() => setDbProperties([]))
      .finally(() => setLoadingProps(false))
  }, [value.data_source_id, value.api_token, sourceId])

  const filters = (value.filters as NotionFilterRow[]) ?? []

  const updateFilters = (newFilters: NotionFilterRow[]) => {
    updateField('filters', newFilters)
  }

  const addFilter = () => {
    updateFilters([...filters, { property: '', type: '', values: [] }])
  }

  const removeFilter = (index: number) => {
    updateFilters(filters.filter((_, i) => i !== index))
  }

  const updateFilter = (index: number, update: Partial<NotionFilterRow>) => {
    const next = [...filters]
    next[index] = { ...next[index], ...update }
    updateFilters(next)
  }

  const hasToken = !!(value.api_token as string)
  const hasDataSource = !!(value.data_source_id as string)

  return (
    <div className="space-y-3">
      {/* Integration Token */}
      <div className="space-y-1.5">
        <Label>Integration Token</Label>
        <p className="text-xs text-muted-foreground">
          From notion.so/profile/integrations
        </p>
        <Input
          type="password"
          value={(value.api_token as string) ?? ''}
          onChange={(e) => updateField('api_token', e.target.value)}
          placeholder="ntn_..."
          required
        />
      </div>

      {/* Data source */}
      {hasToken && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>Data source *</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setDataSourceRefreshKey((current) => current + 1)}
              disabled={loadingDataSources}
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              Refresh
            </Button>
          </div>
          {loadingDataSources ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading data sources...
            </div>
          ) : dataSourcesError ? (
            <div className="text-xs text-destructive py-2">
              Could not load data sources. Refresh, or check the Notion token and
              sharing permissions.
            </div>
          ) : (
            <SearchableSelect
              options={dataSources}
              value={(value.data_source_id as string) ?? ''}
              onChange={(v) => onChange({ ...value, data_source_id: v, filters: [] })}
              placeholder="Select data source..."
            />
          )}
        </div>
      )}

      {/* Filters */}
      {hasDataSource && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>Filters</Label>
            {filters.length > 0 && (
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                and between rows, or within values
              </span>
            )}
          </div>
          {loadingProps ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading properties...
            </div>
          ) : (
            <div className="space-y-2">
              {filters.map((filter, index) => (
                <div key={index}>
                  {index > 0 && (
                    <div className="flex items-center gap-2 py-1">
                      <div className="flex-1 border-t border-border" />
                      <span className="text-[10px] font-medium text-muted-foreground uppercase">and</span>
                      <div className="flex-1 border-t border-border" />
                    </div>
                  )}
                  <FilterRow
                    filter={filter}
                    properties={dbProperties}
                    usedProperties={filters
                      .map((f, i) => (i !== index ? f.property : ''))
                      .filter(Boolean)}
                    onChange={(update) => updateFilter(index, update)}
                    onRemove={() => removeFilter(index)}
                  />
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addFilter}
                className="w-full"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add filter
              </Button>
            </div>
          )}
        </div>
      )}

    </div>
  )
}

// ── Filter Row ───────────────────────────────────────────────

function FilterRow({
  filter,
  properties,
  usedProperties,
  onChange,
  onRemove
}: {
  filter: NotionFilterRow
  properties: NotionPropertyInfo[]
  usedProperties: string[]
  onChange: (update: Partial<NotionFilterRow>) => void
  onRemove: () => void
}) {
  const availableProperties = properties.filter(
    (p) => !usedProperties.includes(p.name)
  )

  const currentProperty = properties.find((p) => p.name === filter.property)
  const isEnumType = currentProperty ? ENUM_PROPERTY_TYPES.has(currentProperty.type) : false

  return (
    <div className="rounded-md border border-input p-2 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SearchableSelect
            options={availableProperties.map((p) => ({
              value: p.name,
              label: `${p.name} (${formatPropertyType(p.type)})`
            }))}
            value={filter.property}
            onChange={(propName) => {
              const prop = properties.find((p) => p.name === propName)
              onChange({ property: propName, type: prop?.type ?? '', values: [] })
            }}
            placeholder="Select property..."
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {filter.property && (
        <div>
          {currentProperty?.type === 'checkbox' ? (
            <select
              value={filter.values[0] ?? ''}
              onChange={(e) => onChange({ values: e.target.value ? [e.target.value] : [] })}
              className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm cursor-pointer"
            >
              <option value="">Any</option>
              <option value="true">Checked</option>
              <option value="false">Not checked</option>
            </select>
          ) : isEnumType && currentProperty?.options?.length ? (
            <MultiSelectValues
              options={currentProperty.options}
              selected={filter.values}
              onChange={(values) => onChange({ values })}
            />
          ) : (
            <Input
              value={filter.values[0] ?? ''}
              onChange={(e) => onChange({ values: e.target.value ? [e.target.value] : [] })}
              placeholder="Contains..."
              className="text-sm h-8"
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── Multi-select Value Picker ────────────────────────────────

function MultiSelectValues({
  options,
  selected,
  onChange
}: {
  options: NotionPropertyOption[]
  selected: string[]
  onChange: (values: string[]) => void
}) {
  const [search, setSearch] = useState('')

  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options

  const toggle = (val: string) => {
    onChange(
      selected.includes(val)
        ? selected.filter((v) => v !== val)
        : [...selected, val]
    )
  }

  return (
    <div className="space-y-1">
      {options.length > 5 && (
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search values..."
            className="w-full rounded border border-input bg-transparent pl-7 pr-2 py-1 text-xs outline-none"
          />
        </div>
      )}
      <div className="max-h-32 overflow-y-auto space-y-0.5">
        {filtered.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-2 text-sm cursor-pointer rounded px-2 py-0.5 hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={selected.includes(opt.value)}
              onChange={() => toggle(opt.value)}
              className="rounded border-input"
            />
            {opt.label}
          </label>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground px-2 py-1">No matching values</p>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────

function formatPropertyType(type: string): string {
  return PROPERTY_TYPE_LABELS[type] ?? type
}
