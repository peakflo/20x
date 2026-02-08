import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Label } from '@/components/ui/Label'
import { Checkbox } from '@/components/ui/Checkbox'
import { createId } from '@paralleldrive/cuid2'
import type { OutputField, OutputFieldType } from '@/types'
import { OUTPUT_FIELD_TYPES } from '@/types'

interface OutputFieldsEditorProps {
  fields: OutputField[]
  onChange: (fields: OutputField[]) => void
}

export function OutputFieldsEditor({ fields, onChange }: OutputFieldsEditorProps) {
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<OutputFieldType>('text')

  const addField = () => {
    if (!newName.trim()) return
    const field: OutputField = {
      id: createId(),
      name: newName.trim(),
      type: newType
    }
    onChange([...fields, field])
    setNewName('')
    setNewType('text')
  }

  const removeField = (id: string) => {
    onChange(fields.filter((f) => f.id !== id))
  }

  const updateField = (id: string, updates: Partial<OutputField>) => {
    onChange(fields.map((f) => (f.id === id ? { ...f, ...updates } : f)))
  }

  return (
    <div className="space-y-3">
      <Label>Output Fields</Label>
      <p className="text-xs text-muted-foreground">
        Define fields that agents should fill when completing this task.
      </p>

      {fields.length > 0 && (
        <div className="space-y-2">
          {fields.map((field) => (
            <div key={field.id} className="flex items-start gap-2 rounded-md border p-3">
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{field.name}</span>
                  <span className="text-xs text-muted-foreground">({field.type})</span>
                  {field.required && <span className="text-xs text-destructive">required</span>}
                  {field.multiple && <span className="text-xs text-muted-foreground">multiple</span>}
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox
                      checked={field.required || false}
                      onCheckedChange={(checked) => updateField(field.id, { required: !!checked })}
                    />
                    Required
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox
                      checked={field.multiple || false}
                      onCheckedChange={(checked) => updateField(field.id, { multiple: !!checked })}
                    />
                    Multiple
                  </label>
                </div>

                {field.type === 'list' && (
                  <OptionsEditor
                    options={field.options || []}
                    onChange={(options) => updateField(field.id, { options })}
                  />
                )}
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={() => removeField(field.id)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Field name..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addField()
              }
            }}
          />
        </div>
        <Select
          value={newType}
          onChange={(e) => setNewType(e.target.value as OutputFieldType)}
          options={OUTPUT_FIELD_TYPES}
          className="w-32"
        />
        <Button type="button" variant="outline" size="sm" onClick={addField} disabled={!newName.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>
    </div>
  )
}

function OptionsEditor({ options, onChange }: { options: string[]; onChange: (options: string[]) => void }) {
  const [newOption, setNewOption] = useState('')

  const addOption = () => {
    if (!newOption.trim()) return
    onChange([...options, newOption.trim()])
    setNewOption('')
  }

  return (
    <div className="space-y-1.5 pl-1">
      <span className="text-xs text-muted-foreground">Options:</span>
      <div className="flex flex-wrap gap-1">
        {options.map((opt, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-xs">
            {opt}
            <button
              type="button"
              onClick={() => onChange(options.filter((_, idx) => idx !== i))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          value={newOption}
          onChange={(e) => setNewOption(e.target.value)}
          placeholder="Add option..."
          className="h-7 text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addOption()
            }
          }}
        />
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={addOption} disabled={!newOption.trim()}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
