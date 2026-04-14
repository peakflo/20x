import { useCallback, useEffect, useRef } from 'react'
import { CheckSquare, MessageSquare, Monitor, X } from 'lucide-react'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import type { CanvasPanelType } from '@/stores/canvas-store'

interface ContextMenuPosition {
  clientX: number
  clientY: number
  canvasX: number
  canvasY: number
}

interface CanvasContextMenuProps {
  position: ContextMenuPosition
  onClose: () => void
}

export function CanvasContextMenu({ position, onClose }: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const tasks = useTaskStore((s) => s.tasks)
  const sessions = useAgentStore((s) => s.sessions)
  const addPanel = useCanvasStore((s) => s.addPanel)
  const panels = useCanvasStore((s) => s.panels)

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Delay to prevent immediate close from the right-click event
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
      document.addEventListener('keydown', handleKey)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const handleAddPanel = useCallback(
    (type: CanvasPanelType, title: string, refId?: string) => {
      // Offset slightly to avoid exact overlap with existing panels
      const offset = (panels.length % 5) * 20
      addPanel({
        type,
        title,
        refId,
        x: position.canvasX + offset,
        y: position.canvasY + offset,
        width: DEFAULT_PANEL_WIDTH,
        height: DEFAULT_PANEL_HEIGHT,
      })
      onClose()
    },
    [addPanel, onClose, panels.length, position.canvasX, position.canvasY]
  )

  // Reusable tasks for the menu (non-completed, max 10)
  const availableTasks = tasks
    .filter((t) => t.status !== 'completed')
    .slice(0, 10)

  // Tasks with active sessions
  const activeSessions = Array.from(sessions.entries())
    .filter(([, session]) => session.messages.length > 0)
    .slice(0, 10)

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[220px] max-w-[280px] bg-[#161b22] border border-border/50 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100"
      style={{ left: position.clientX, top: position.clientY }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/20">
        <span className="text-[11px] font-medium text-muted-foreground/70">
          Add to Canvas
        </span>
        <button
          onClick={onClose}
          className="text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="py-1 max-h-[400px] overflow-y-auto custom-scrollbar">
        {/* Quick add section */}
        <MenuSection title="Quick Add">
          <MenuItem
            icon={<Monitor className="h-3.5 w-3.5 text-green-400" />}
            label="Application Panel"
            onClick={() => handleAddPanel('app', 'Application')}
          />
        </MenuSection>

        {/* Tasks section */}
        {availableTasks.length > 0 && (
          <MenuSection title="Tasks">
            {availableTasks.map((task) => (
              <MenuItem
                key={task.id}
                icon={<CheckSquare className="h-3.5 w-3.5 text-blue-400" />}
                label={task.title}
                sublabel={task.status.replace(/_/g, ' ')}
                onClick={() => handleAddPanel('task', task.title, task.id)}
              />
            ))}
          </MenuSection>
        )}

        {/* Transcripts section */}
        {activeSessions.length > 0 && (
          <MenuSection title="Agent Transcripts">
            {activeSessions.map(([taskId, session]) => {
              const task = tasks.find((t) => t.id === taskId)
              return (
                <MenuItem
                  key={taskId}
                  icon={<MessageSquare className="h-3.5 w-3.5 text-purple-400" />}
                  label={task?.title || `Session ${taskId.slice(0, 8)}`}
                  sublabel={`${session.messages.length} messages`}
                  onClick={() =>
                    handleAddPanel(
                      'transcript',
                      `Transcript: ${task?.title || taskId.slice(0, 8)}`,
                      taskId
                    )
                  }
                />
              )
            })}
          </MenuSection>
        )}

        {/* Empty state */}
        {availableTasks.length === 0 && activeSessions.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground/40">
            No tasks or sessions available.
            <br />
            Create tasks first, then add them to the canvas.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────

function MenuSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="py-1">
      <div className="px-3 py-1 text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider">
        {title}
      </div>
      {children}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  sublabel,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  sublabel?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 transition-colors group"
    >
      <span className="flex-shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-foreground/80 truncate group-hover:text-foreground transition-colors">
          {label}
        </div>
        {sublabel && (
          <div className="text-[10px] text-muted-foreground/40 truncate">
            {sublabel}
          </div>
        )}
      </div>
    </button>
  )
}
