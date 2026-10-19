import { useState, useEffect, useMemo, useCallback } from 'react'
import { Plus, Edit3, Trash2, Pin, PinOff, BrainCircuit, Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Checkbox } from '@/components/ui/Checkbox'
import { SettingsSection } from '../SettingsSection'
import { MemoryFormDialog } from '../forms/MemoryFormDialog'
import { useMemoryStore } from '@/stores/memory-store'
import { onMastermindMemorySaved, onMastermindMemoryDeleted, memoryApi, settingsApi } from '@/lib/ipc-client'
import { MEMORY_KIND_OPTIONS, MEMORY_SCOPE_GLOBAL } from '@/types'
import { MASTERMIND_SAVE_WHAT_I_LEARNED_SETTING } from '@shared/mastermind-memory'
import type { MastermindMemory, CreateMemoryDTO, UpdateMemoryDTO, MemoryKind } from '@/types'

interface MemoryDialogState {
  open: boolean
  memory?: MastermindMemory
}

export function MemorySettings() {
  const { memories, fetchMemories, createMemory, updateMemory, deleteMemory, clearAll } = useMemoryStore()
  const [dialog, setDialog] = useState<MemoryDialogState>({ open: false })
  const [search, setSearch] = useState('')
  const [scopeFilter, setScopeFilter] = useState<string>('')
  const [kindFilter, setKindFilter] = useState<MemoryKind | ''>('')
  const [importResult, setImportResult] = useState<string | null>(null)
  const [saveWhatILearned, setSaveWhatILearned] = useState(false)

  useEffect(() => {
    fetchMemories()
  }, [fetchMemories])

  useEffect(() => {
    settingsApi.get(MASTERMIND_SAVE_WHAT_I_LEARNED_SETTING).then((value) => setSaveWhatILearned(value === 'true'))
  }, [])

  const handleToggleSaveWhatILearned = useCallback(async (checked: boolean) => {
    setSaveWhatILearned(checked)
    await settingsApi.set(MASTERMIND_SAVE_WHAT_I_LEARNED_SETTING, checked ? 'true' : 'false')
  }, [])

  // Keep the list live while a Mastermind session saves/forgets in the background.
  useEffect(() => {
    const unsubSaved = onMastermindMemorySaved(() => fetchMemories())
    const unsubDeleted = onMastermindMemoryDeleted(() => fetchMemories())
    return () => {
      unsubSaved()
      unsubDeleted()
    }
  }, [fetchMemories])

  const scopes = useMemo(() => {
    const set = new Set<string>([MEMORY_SCOPE_GLOBAL])
    for (const m of memories) set.add(m.scope)
    return Array.from(set)
  }, [memories])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return memories
      .filter((m) => !scopeFilter || m.scope === scopeFilter)
      .filter((m) => !kindFilter || m.kind === kindFilter)
      .filter((m) => !q || m.content.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updated_at.localeCompare(a.updated_at)
      })
  }, [memories, search, scopeFilter, kindFilter])

  const handleCreate = async (data: CreateMemoryDTO | UpdateMemoryDTO) => {
    await createMemory(data as CreateMemoryDTO)
    setDialog({ open: false })
  }

  const handleUpdate = async (data: CreateMemoryDTO | UpdateMemoryDTO) => {
    if (dialog.memory) {
      await updateMemory(dialog.memory.id, data as UpdateMemoryDTO)
      setDialog({ open: false })
    }
  }

  const handleDelete = async (id: string) => {
    if (confirm('Forget this memory?')) {
      await deleteMemory(id)
    }
  }

  const handleTogglePin = async (memory: MastermindMemory) => {
    await updateMemory(memory.id, { pinned: !memory.pinned })
  }

  const handleClearAll = async () => {
    if (!confirm(scopeFilter ? `Clear all memories in scope "${scopeFilter}"?` : 'Clear ALL memories? This cannot be undone.')) return
    await clearAll(scopeFilter || undefined)
  }

  const handleExport = useCallback(async () => {
    await memoryApi.exportToFile()
  }, [])

  const handleImport = useCallback(async () => {
    const result = await memoryApi.importFromFile()
    if ('canceled' in result) return
    setImportResult(`Imported ${result.imported}, skipped ${result.skipped}.`)
    await fetchMemories()
  }, [fetchMemories])

  return (
    <>
      <SettingsSection
        title="Memory"
        description="What Mastermind remembers across restarts — stable preferences, decisions, facts, goals, people and procedures. Stays local to this machine."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memories..."
            className="flex-1 min-w-[160px]"
            aria-label="Search memories"
          />
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            className="bg-transparent border border-border rounded px-2 py-1.5 text-sm"
            aria-label="Filter by scope"
          >
            <option value="">All scopes</option>
            {scopes.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as MemoryKind | '')}
            className="bg-transparent border border-border rounded px-2 py-1.5 text-sm capitalize"
            aria-label="Filter by kind"
          >
            <option value="">All kinds</option>
            {MEMORY_KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <Button size="sm" onClick={() => setDialog({ open: true })}>
            <Plus className="h-3.5 w-3.5" />
            Add Memory
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {filtered.length} of {memories.length} memor{memories.length === 1 ? 'y' : 'ies'}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleExport} title="Export all memories as JSON">
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
            <Button variant="ghost" size="sm" onClick={handleImport} title="Import memories from a JSON export">
              <Upload className="h-3.5 w-3.5" />
              Import
            </Button>
            {memories.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleClearAll} className="text-destructive hover:text-destructive">
                Clear all
              </Button>
            )}
          </div>
        </div>

        {importResult && (
          <p className="text-xs text-muted-foreground">{importResult}</p>
        )}

        {memories.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <BrainCircuit className="h-8 w-8 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-1">Mastermind doesn&apos;t remember anything yet</p>
            <p className="text-xs text-muted-foreground mb-3">
              It saves stable preferences, decisions and procedures as you talk to it — or add one yourself.
            </p>
            <Button size="sm" onClick={() => setDialog({ open: true })}>
              <Plus className="h-3.5 w-3.5" />
              Add Your First Memory
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((memory) => (
              <div key={memory.id} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="flex items-start gap-3 px-4 py-3">
                  <BrainCircuit className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">{memory.kind}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">{memory.scope}</span>
                      <span className="text-[10px] text-muted-foreground">importance {memory.importance}</span>
                      {memory.pinned && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary">pinned</span>}
                    </div>
                    <p className="text-sm mt-1 whitespace-pre-wrap">{memory.content}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {memory.source} · updated {new Date(memory.updated_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleTogglePin(memory)}
                      title={memory.pinned ? 'Unpin' : 'Pin'}
                    >
                      {memory.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDialog({ open: true, memory })}
                      title="Edit"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(memory.id)}
                      className="text-destructive hover:text-destructive"
                      title="Forget"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="End-of-conversation capture"
        description="Optional, off by default. When on, clearing a Mastermind conversation first asks it to propose memories from that conversation — each proposal still goes through the normal save toast with Undo."
      >
        <label className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-border cursor-pointer hover:bg-accent/50">
          <Checkbox checked={saveWhatILearned} onCheckedChange={(checked) => handleToggleSaveWhatILearned(checked === true)} />
          <span className="text-sm">Offer "Save what I learned" when clearing a Mastermind conversation</span>
        </label>
      </SettingsSection>

      <MemoryFormDialog
        memory={dialog.memory}
        open={dialog.open}
        onClose={() => setDialog({ open: false })}
        onSubmit={dialog.memory ? handleUpdate : handleCreate}
      />
    </>
  )
}
