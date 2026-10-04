import { useState, type ReactNode } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { MessageQueueSnapshot, QueuedMessageAttachment } from '@shared/message-queue'

function SortableQueueItem({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }} className="relative flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1">
    <button type="button" className="cursor-grab touch-none" aria-label="Drag to reorder" {...attributes} {...listeners}>⋮⋮</button>
    {children}
  </li>
}

export interface MessageQueueActions {
  update: (taskId: string, id: string, text: string, attachments: QueuedMessageAttachment[]) => Promise<MessageQueueSnapshot>
  reorder: (taskId: string, ids: string[]) => Promise<MessageQueueSnapshot>
  delete: (taskId: string, id: string) => Promise<MessageQueueSnapshot>
  promote: (taskId: string, id: string) => Promise<MessageQueueSnapshot>
  resume: (taskId: string) => Promise<MessageQueueSnapshot>
}

export function MessageQueueList({ taskId, snapshot, actions, canSteer, onChange }: {
  taskId: string
  snapshot: MessageQueueSnapshot
  actions: MessageQueueActions
  canSteer: boolean
  onChange: (snapshot: MessageQueueSnapshot) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<QueuedMessageAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const apply = async (operation: Promise<MessageQueueSnapshot>): Promise<void> => {
    try { onChange(await operation); setError(null) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  if (!snapshot.messages.length) return null
  return <div className="border-t border-border px-3 py-2 text-xs" aria-label="Queued messages">
    <div className="mb-2 flex items-center justify-between gap-2">
      <strong>Queued messages ({snapshot.messages.length})</strong>
      {snapshot.paused && <span className="text-amber-500">Paused after error</span>}
      <button type="button" className="text-primary underline" onClick={() => void apply(actions.resume(taskId))}>Resume queue</button>
    </div>
    {error && <div role="alert" className="mb-1 text-destructive">{error}</div>}
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return
      const ids = snapshot.messages.map((entry) => entry.id)
      void apply(actions.reorder(taskId, arrayMove(ids, ids.indexOf(String(event.active.id)), ids.indexOf(String(event.over.id)))))
    }}><SortableContext items={snapshot.messages.map((item) => item.id)} strategy={verticalListSortingStrategy}><ol className="space-y-1">
      {snapshot.messages.map((item) => <SortableQueueItem key={item.id} id={item.id}>
        {editingId === item.id ? <div className="min-w-0 flex-1"><input autoFocus className="w-full rounded border bg-background px-1" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { void apply(actions.update(taskId, item.id, draft, draftAttachments)); setEditingId(null) } }} />{draftAttachments.map((attachment) => <button key={attachment.id} type="button" className="mr-1 text-muted-foreground" title={`Remove ${attachment.filename}`} onClick={() => setDraftAttachments((current) => current.filter((entry) => entry.id !== attachment.id))}>{attachment.filename} ×</button>)}</div> : <span className="min-w-0 flex-1 truncate">{item.text || '(attachments)'}{item.attachments.length > 0 && ` · ${item.attachments.length} file(s)`}</span>}
        {editingId === item.id ? <button type="button" onClick={() => { void apply(actions.update(taskId, item.id, draft, draftAttachments)); setEditingId(null) }}>Save</button> : <button type="button" onClick={() => { setEditingId(item.id); setDraft(item.text); setDraftAttachments(item.attachments) }}>Edit</button>}
        {editingId === item.id && <button type="button" onClick={() => setEditingId(null)}>Cancel</button>}
        <button type="button" aria-label="Move up" disabled={item.id === snapshot.messages[0]?.id} onClick={() => { const ids = snapshot.messages.map((entry) => entry.id); const index = ids.indexOf(item.id); if (index > 0) { [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void apply(actions.reorder(taskId, ids)) } }}>↑</button>
        <button type="button" aria-label="Move down" disabled={item.id === snapshot.messages.at(-1)?.id} onClick={() => { const ids = snapshot.messages.map((entry) => entry.id); const index = ids.indexOf(item.id); if (index < ids.length - 1) { [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]]; void apply(actions.reorder(taskId, ids)) } }}>↓</button>
        {canSteer && <button type="button" onClick={() => void apply(actions.promote(taskId, item.id))}>Steer now</button>}
        <button type="button" aria-label="Delete queued message" onClick={() => void apply(actions.delete(taskId, item.id))}>✕</button>
      </SortableQueueItem>)}
    </ol></SortableContext></DndContext>
  </div>
}
