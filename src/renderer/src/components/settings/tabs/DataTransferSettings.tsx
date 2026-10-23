import { useState } from 'react'
import { CheckCircle, Download, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { SettingsSection } from '../SettingsSection'
import { dataTransferApi } from '@/lib/ipc-client'
import {
  DATA_CATEGORIES,
  DATA_CATEGORY_LABELS,
  type DataCategory,
  type DataImportPreview,
  type DataImportResult
} from '@shared/data-transfer'

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'exported'; path: string }
  | { kind: 'imported'; result: DataImportResult }
  | { kind: 'error'; message: string }

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors thrown in a main-process handler.
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function CategoryList({
  categories,
  selected,
  counts,
  disabled,
  onToggle
}: {
  categories: readonly DataCategory[]
  selected: Set<DataCategory>
  counts?: Partial<Record<DataCategory, number>>
  disabled: boolean
  onToggle: (category: DataCategory, checked: boolean) => void
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {categories.map((category) => {
        const { label, hint } = DATA_CATEGORY_LABELS[category]
        const id = `data-category-${category}`
        return (
          <label key={category} htmlFor={id} className="flex items-start gap-2.5 rounded-md border border-border p-2.5 cursor-pointer">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={selected.has(category)}
              disabled={disabled}
              onCheckedChange={(checked) => onToggle(category, checked === true)}
            />
            <span className="space-y-0.5">
              <span className="block text-sm text-foreground">
                {label}
                {counts?.[category] !== undefined && (
                  <span className="ml-1.5 text-muted-foreground">({counts[category]})</span>
                )}
              </span>
              <span className="block text-xs text-muted-foreground">{hint}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

export function DataTransferSettings() {
  const [exportSelection, setExportSelection] = useState(() => new Set<DataCategory>(DATA_CATEGORIES))
  const [preview, setPreview] = useState<DataImportPreview | null>(null)
  const [importSelection, setImportSelection] = useState(() => new Set<DataCategory>())
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const busy = status.kind === 'busy'

  const toggle = (set: Set<DataCategory>, category: DataCategory, checked: boolean): Set<DataCategory> => {
    const next = new Set(set)
    if (checked) next.add(category)
    else next.delete(category)
    return next
  }

  const handleExport = async () => {
    setStatus({ kind: 'busy', message: 'Exporting…' })
    try {
      const result = await dataTransferApi.exportData([...exportSelection])
      setStatus(result.canceled ? { kind: 'idle' } : { kind: 'exported', path: result.path })
    } catch (err) {
      setStatus({ kind: 'error', message: errorMessage(err) })
    }
  }

  const handlePickImport = async () => {
    setStatus({ kind: 'busy', message: 'Reading file…' })
    try {
      const picked = await dataTransferApi.pickImport()
      setPreview(picked)
      setImportSelection(new Set(picked ? (Object.keys(picked.categories) as DataCategory[]) : []))
      setStatus({ kind: 'idle' })
    } catch (err) {
      setPreview(null)
      setStatus({ kind: 'error', message: errorMessage(err) })
    }
  }

  const handleCancelImport = () => {
    setPreview(null)
    void dataTransferApi.cancelImport()
  }

  const handleImport = async () => {
    setStatus({ kind: 'busy', message: 'Importing…' })
    try {
      const result = await dataTransferApi.importData([...importSelection])
      setPreview(null)
      setStatus({ kind: 'imported', result })
    } catch (err) {
      setPreview(null)
      setStatus({ kind: 'error', message: errorMessage(err) })
    }
  }

  const importedTotal = status.kind === 'imported'
    ? Object.values(status.result.tables).reduce((sum, t) => sum + t.inserted, 0)
    : 0
  const skippedTotal = status.kind === 'imported'
    ? Object.values(status.result.tables).reduce((sum, t) => sum + t.skipped, 0)
    : 0

  return (
    <SettingsSection
      title="Backup and restore"
      description="Save your 20x data to a file, or bring it in from another computer. Passwords, tokens, API keys and secret values are never included."
    >
      <div className="space-y-3">
        <CategoryList
          categories={DATA_CATEGORIES}
          selected={exportSelection}
          disabled={busy}
          onToggle={(category, checked) => setExportSelection((s) => toggle(s, category, checked))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleExport} disabled={busy || exportSelection.size === 0}>
            <Download className="h-3.5 w-3.5" />
            Export…
          </Button>
          <Button size="sm" variant="outline" onClick={handlePickImport} disabled={busy}>
            <Upload className="h-3.5 w-3.5" />
            Import…
          </Button>
          {busy && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {status.message}
            </span>
          )}
        </div>
      </div>

      {preview && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-foreground">{preview.fileName}</p>
            <p className="text-xs text-muted-foreground">
              Exported {new Date(preview.manifest.exportedAt).toLocaleString()} from 20x {preview.manifest.appVersion}.
              Choose what to bring in. Nothing you have now is deleted, and items you already have are kept as they are.
            </p>
          </div>
          <CategoryList
            categories={DATA_CATEGORIES.filter((c) => preview.categories[c] !== undefined)}
            selected={importSelection}
            counts={preview.categories}
            disabled={busy}
            onToggle={(category, checked) => setImportSelection((s) => toggle(s, category, checked))}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleImport} disabled={busy || importSelection.size === 0}>
              Import selected
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancelImport} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {status.kind === 'exported' && (
        <p className="flex items-center gap-1.5 text-xs text-foreground">
          <CheckCircle className="h-3.5 w-3.5 text-primary" />
          Saved to {status.path}
        </p>
      )}

      {status.kind === 'imported' && (
        <div className="space-y-2 rounded-md border border-border p-3 text-xs">
          <p className="flex items-center gap-1.5 text-foreground">
            <CheckCircle className="h-3.5 w-3.5 text-primary" />
            Imported {importedTotal} items
            {status.result.attachments > 0 && ` and ${status.result.attachments} attachments`}
            {skippedTotal > 0 && `. ${skippedTotal} you already had were kept as they are`}.
          </p>
          {status.result.secretsNeedingValues.length > 0 && (
            <p className="text-muted-foreground">
              Add values in Settings → Secrets for: {status.result.secretsNeedingValues.join(', ')}.
            </p>
          )}
          <p className="text-muted-foreground">
            Reload to see everything. Connected task sources and MCP servers that need a sign-in or token have to be set up again.
          </p>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload now
          </Button>
        </div>
      )}

      {status.kind === 'error' && (
        <p className="text-xs text-destructive">{status.message}</p>
      )}
    </SettingsSection>
  )
}
