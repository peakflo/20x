import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { MastermindMemoryRecord } from '@shared/mastermind-memory'

/**
 * Mobile Settings: read-only list of what Mastermind remembers, plus
 * delete. Add/edit/pin/export/import stay desktop-only (see
 * src/renderer/src/components/settings/tabs/MemorySettings.tsx) — this
 * mirrors the "mobile gets a read-only list plus delete" rule used
 * elsewhere (ACP agents, harness maintenance) on this page.
 */
export function MemorySection() {
  const [memories, setMemories] = useState<MastermindMemoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.memories.list()
      setMemories(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load memories')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id)
    try {
      await api.memories.delete(id)
      setMemories((prev) => prev.filter((m) => m.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete memory')
    } finally {
      setDeletingId(null)
    }
  }, [])

  if (loading) return null

  return (
    <section className="rounded-2xl bg-card p-4 space-y-2" aria-label="Memory">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Memory</h2>
        <span className="text-xs text-muted-foreground">{memories.length}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        What Mastermind remembers across restarts. Add, edit and pin from the desktop app.
      </p>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {memories.length === 0 ? (
        <p className="text-xs text-muted-foreground/60 py-2">Nothing remembered yet.</p>
      ) : (
        <div className="space-y-1.5">
          {memories.map((memory) => (
            <div key={memory.id} className="flex items-start gap-2 rounded-lg border border-border/30 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">{memory.kind}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">{memory.scope}</span>
                  {memory.pinned && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary">pinned</span>}
                </div>
                <p className="text-sm mt-1 whitespace-pre-wrap">{memory.content}</p>
              </div>
              <button
                onClick={() => handleDelete(memory.id)}
                disabled={deletingId === memory.id}
                className="shrink-0 p-1.5 rounded-md hover:bg-accent disabled:opacity-50 text-muted-foreground"
                aria-label="Forget this memory"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
