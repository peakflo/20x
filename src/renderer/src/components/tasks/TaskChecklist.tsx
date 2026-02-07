import { useState } from 'react'
import { Plus, X, Square, CheckSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChecklistItem } from '@/types'

interface TaskChecklistProps {
  items: ChecklistItem[]
  onChange: (items: ChecklistItem[]) => void
  readOnly?: boolean
}

export function TaskChecklist({ items, onChange, readOnly = false }: TaskChecklistProps) {
  const [newItemText, setNewItemText] = useState('')

  const toggleItem = (id: string) => {
    onChange(items.map((item) => (item.id === id ? { ...item, completed: !item.completed } : item)))
  }

  const removeItem = (id: string) => {
    onChange(items.filter((item) => item.id !== id))
  }

  const addItem = () => {
    if (!newItemText.trim()) return
    onChange([...items, { id: crypto.randomUUID(), text: newItemText.trim(), completed: false }])
    setNewItemText('')
  }

  const completedCount = items.filter((i) => i.completed).length

  return (
    <div className="space-y-2" role="group" aria-label="Checklist">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Checklist</span>
        {items.length > 0 && (
          <span className="text-xs text-muted-foreground">{completedCount}/{items.length}</span>
        )}
      </div>

      {items.length > 0 && (
        <div className="space-y-1" role="list">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 group" role="listitem">
              <button
                type="button"
                onClick={() => toggleItem(item.id)}
                disabled={readOnly}
                role="checkbox"
                aria-checked={item.completed}
                className="shrink-0 text-muted-foreground hover:text-foreground cursor-pointer disabled:cursor-default"
              >
                {item.completed ? <CheckSquare className="h-4 w-4 text-emerald-400" /> : <Square className="h-4 w-4" />}
              </button>
              <span className={cn('text-sm flex-1', item.completed && 'text-muted-foreground line-through')}>
                {item.text}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => removeItem(item.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem() } }}
            placeholder="Add checklist item..."
            className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            type="button"
            onClick={addItem}
            disabled={!newItemText.trim()}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
