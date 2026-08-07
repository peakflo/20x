import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SearchableSelectOption {
  value: string
  label: string
}

interface SearchableSelectProps {
  options: SearchableSelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  id?: string
  className?: string
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  id,
  className
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const q = search.trim().toLowerCase()
  const filtered = q
    ? options.filter(
        (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
      )
    : options

  const selectedLabel = options.find((o) => o.value === value)?.label ?? (value || undefined)

  const close = () => {
    setOpen(false)
    setSearch('')
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close()
          } else {
            setOpen(true)
            setTimeout(() => inputRef.current?.focus(), 0)
          }
        }}
        className="w-full flex items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
      >
        <span className={cn('truncate text-left', selectedLabel ? '' : 'text-muted-foreground')}>
          {selectedLabel || placeholder || 'Select...'}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-input bg-popover shadow-md">
          <div className="relative border-b border-input">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  close()
                }
              }}
              placeholder="Search..."
              className="w-full bg-transparent pl-8 pr-3 py-2 text-sm outline-none"
            />
          </div>
          <div className="max-h-48 overflow-y-auto p-1" role="listbox">
            {filtered.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onClick={() => {
                  onChange(opt.value)
                  close()
                }}
                className={cn(
                  'w-full text-left rounded px-2 py-1.5 text-sm hover:bg-accent cursor-pointer',
                  opt.value === value && 'bg-accent'
                )}
              >
                {opt.label}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No results</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
