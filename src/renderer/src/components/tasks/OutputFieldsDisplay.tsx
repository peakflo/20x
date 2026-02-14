import { useState, useEffect, useCallback, useMemo } from 'react'
import { FileOutput, CheckCircle2, FileText, FolderOpen, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Checkbox } from '@/components/ui/Checkbox'
import { Label } from '@/components/ui/Label'
import { shellApi } from '@/lib/ipc-client'
import type { OutputField } from '@/types'

function isFieldFilled(field: OutputField): boolean {
  const v = field.value
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  if (typeof v === 'boolean') return true
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

interface OutputFieldsDisplayProps {
  fields: OutputField[]
  onChange: (fields: OutputField[]) => void
  isActive?: boolean
  onComplete?: () => void
  taskUpdatedAt?: string  // Timestamp to force file preview refresh
}

export function OutputFieldsDisplay({ fields, onChange, isActive, onComplete, taskUpdatedAt }: OutputFieldsDisplayProps) {
  if (fields.length === 0) return null

  const updateValue = useCallback(
    (id: string, value: unknown) => {
      onChange(fields.map((f) => (f.id === id ? { ...f, value } : f)))
    },
    [fields, onChange]
  )

  const allFilled = useMemo(() => fields.every(isFieldFilled), [fields])
  const filledCount = useMemo(() => fields.filter(isFieldFilled).length, [fields])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileOutput className="h-3.5 w-3.5" /> Output Fields
          <span className="text-xs">({filledCount}/{fields.length})</span>
        </div>
      </div>
      <div className="space-y-3">
        {fields.map((field) => (
          <OutputFieldInput key={field.id} field={field} onValueChange={(v) => updateValue(field.id, v)} taskUpdatedAt={taskUpdatedAt} />
        ))}
      </div>
      {isActive && onComplete && allFilled && (
        <Button onClick={onComplete} className="w-full gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Complete Task
        </Button>
      )}
    </div>
  )
}

function OutputFieldInput({ field, onValueChange, taskUpdatedAt }: { field: OutputField; onValueChange: (value: unknown) => void; taskUpdatedAt?: string }) {
  const [localValue, setLocalValue] = useState<string>(String(field.value ?? ''))

  // Sync local state when field.value changes externally (e.g. agent extraction)
  useEffect(() => {
    setLocalValue(String(field.value ?? ''))
  }, [field.value])

  const handleChange = (val: string) => {
    setLocalValue(val)
    onValueChange(field.type === 'number' ? (val ? Number(val) : null) : val)
  }

  switch (field.type) {
    case 'textarea':
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">
            {field.name}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          <Textarea
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={`Enter ${field.name.toLowerCase()}...`}
            rows={3}
          />
        </div>
      )

    case 'boolean':
      return (
        <div className="flex items-center gap-2">
          <Checkbox
            checked={!!field.value}
            onCheckedChange={(checked) => onValueChange(!!checked)}
          />
          <Label className="text-xs">
            {field.name}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
        </div>
      )

    case 'list':
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">
            {field.name}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          {field.options && field.options.length > 0 ? (
            <Select
              value={String(field.value ?? '')}
              onChange={(e) => onValueChange(e.target.value)}
              options={[
                { value: '', label: `Select ${field.name.toLowerCase()}...` },
                ...field.options.map((opt) => ({ value: opt, label: opt }))
              ]}
            />
          ) : (
            <Input
              value={localValue}
              onChange={(e) => handleChange(e.target.value)}
              placeholder={`Enter ${field.name.toLowerCase()}...`}
            />
          )}
        </div>
      )

    case 'file': {
      const filePaths = Array.isArray(field.value)
        ? field.value.map(String)
        : field.value ? [String(field.value)] : []
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">
            {field.name}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          {filePaths.length > 0 ? (
            <div className="space-y-1.5">
              {filePaths.map((fp) => (
                <FileFieldPreview key={`${fp}-${taskUpdatedAt || ''}`} filePath={fp} taskUpdatedAt={taskUpdatedAt} />
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground rounded-md border px-3 py-2">
              No file — agent will create one
            </div>
          )}
        </div>
      )
    }

    case 'number':
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">
            {field.name}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          <Input
            type="number"
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={`Enter ${field.name.toLowerCase()}...`}
          />
        </div>
      )

    case 'date':
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">
            {field.name}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          <Input
            type="date"
            value={String(field.value ?? '')}
            onChange={(e) => onValueChange(e.target.value)}
          />
        </div>
      )

    // text, email, url, country, currency — all render as text input
    default:
      return (
        <div className="space-y-1.5">
          <Label className="text-xs">
            {field.name}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          <Input
            type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={`Enter ${field.name.toLowerCase()}...`}
          />
        </div>
      )
  }
}

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.html', '.xml', '.yaml', '.yml', '.log', '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.css', '.sql'])

function FileFieldPreview({ filePath, taskUpdatedAt }: { filePath: string; taskUpdatedAt?: string }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fileName = filePath.split('/').pop() || filePath
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : ''
  const isText = TEXT_EXTENSIONS.has(ext)

  useEffect(() => {
    if (!isText) return
    shellApi.readTextFile(filePath).then((result) => {
      if (result?.content) setPreview(result.content)
    })
  }, [filePath, isText, taskUpdatedAt])  // Re-read when task is updated

  return (
    <div className="rounded-md border overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium truncate flex-1">{fileName}</span>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => shellApi.openPath(filePath)}>
            <ExternalLink className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => shellApi.showItemInFolder(filePath)}>
            <FolderOpen className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {preview && (
        <>
          <div className="border-t px-3 py-2 bg-muted/30">
            <pre className={`text-[11px] text-muted-foreground whitespace-pre-wrap break-words font-mono ${expanded ? '' : 'max-h-32 overflow-hidden'}`}>
              {preview}
            </pre>
          </div>
          {preview.split('\n').length > 8 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-full text-[11px] text-muted-foreground hover:text-foreground py-1 border-t bg-muted/20 transition-colors"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
