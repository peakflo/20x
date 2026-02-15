import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'

interface KeyValueEditorProps {
  label: string
  value: Record<string, string>
  onChange: (val: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}

export function KeyValueEditor({
  label,
  value,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value'
}: KeyValueEditorProps) {
  const entries = Object.entries(value)

  const updateEntry = (oldKey: string, newKey: string, newVal: string) => {
    const next = { ...value }
    if (oldKey !== newKey) delete next[oldKey]
    next[newKey] = newVal
    onChange(next)
  }

  const removeEntry = (key: string) => {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange({ ...value, '': '' })}
          className="h-6 text-xs px-2"
        >
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>
      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={k}
                onChange={(e) => updateEntry(k, e.target.value, v)}
                placeholder={keyPlaceholder}
                className="flex-1 text-xs h-8"
              />
              <Input
                value={v}
                onChange={(e) => updateEntry(k, k, e.target.value)}
                placeholder={valuePlaceholder}
                className="flex-1 text-xs h-8"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeEntry(k)}
                className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
