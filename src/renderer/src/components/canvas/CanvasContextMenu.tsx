import { useCallback, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CheckSquare, MessageSquare, Monitor, AppWindow, Globe, TerminalSquare, Plus, X, Square, Circle, Minus, MoveUpRight, Type, Image } from 'lucide-react'
import { useTaskStore } from '@/stores/task-store'
import { useAgentStore } from '@/stores/agent-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus } from '@/types'
import type { CanvasPanelType } from '@/stores/canvas-store'
import type { DrawingTool } from '@/components/canvas/drawing/types'

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

/** Figure tools offered in the "Draw" section of the canvas context menu. */
const DRAW_TOOLS: Array<{ tool: DrawingTool; label: string; icon: typeof Square }> = [
  { tool: 'rectangle', label: 'Rectangle', icon: Square },
  { tool: 'ellipse', label: 'Ellipse', icon: Circle },
  { tool: 'line', label: 'Line', icon: Minus },
  { tool: 'arrow', label: 'Arrow', icon: MoveUpRight },
  { tool: 'text', label: 'Text', icon: Type },
  { tool: 'image', label: 'Image', icon: Image },
]

export function CanvasContextMenu({ position, onClose }: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const tasks = useTaskStore((s) => s.tasks)
  // Project only what the menu renders (task id + message count) instead of
  // subscribing to the whole sessions Map, which gets a new identity on every
  // streamed delta and would re-render the open menu at stream frequency.
  const activeSessions = useAgentStore(
    useShallow((s) =>
      Array.from(s.sessions.entries())
        .filter(([, session]) => session.messages.length > 0)
        .slice(0, 10)
        .map(([taskId, session]) => `${taskId}:${session.messages.length}`)
    )
  ).map((entry) => {
    const separator = entry.lastIndexOf(':')
    return { taskId: entry.slice(0, separator), messageCount: Number(entry.slice(separator + 1)) }
  })
  const applications = useDashboardStore((s) => s.applications)
  const addPanel = useCanvasStore((s) => s.addPanel)
  const panels = useCanvasStore((s) => s.panels)
  const openCreateModal = useUIStore((s) => s.openCreateModal)
  const setDrawingTool = useDrawingStore((s) => s.setTool)

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
    (type: CanvasPanelType, title: string, refId?: string, url?: string) => {
      // Don't add duplicate task/transcript/app panels for the same refId
      if (refId && (type === 'task' || type === 'transcript' || type === 'app')) {
        const exists = panels.some((p) => p.type === type && p.refId === refId)
        if (exists) {
          onClose()
          return
        }
      }

      // Offset slightly to avoid exact overlap with existing panels
      const offset = (panels.length % 5) * 20
      addPanel({
        type,
        title,
        refId,
        url,
        x: position.canvasX + offset,
        y: position.canvasY + offset,
        width: DEFAULT_PANEL_WIDTH,
        height: DEFAULT_PANEL_HEIGHT,
      })
      onClose()
    },
    [addPanel, onClose, panels, position.canvasX, position.canvasY]
  )

  // Reusable tasks for the menu (non-completed, max 10)
  const availableTasks = tasks
    .filter((t) => t.status !== TaskStatus.Completed)
    .slice(0, 10)


  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[220px] max-w-[280px] bg-popover border border-border/50 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100"
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
        {/* Create Task — always at top */}
        <MenuItem
          icon={<Plus className="h-3.5 w-3.5 text-green-400" />}
          label="Create Task"
          sublabel="New task placed at center of canvas"
          onClick={() => {
            openCreateModal()
            onClose()
          }}
        />
        <div className="mx-3 my-1 border-t border-border/20" />

        {/* Browser & Terminal — always available */}
        <MenuSection title="Tools">
          <MenuItem
            icon={<Globe className="h-3.5 w-3.5 text-orange-400" />}
            label="Agent Browser"
            sublabel="Browser controlled by agent via CDP"
            onClick={() => handleAddPanel('browser', 'Agent Browser', undefined, 'https://www.google.com')}
          />
          <MenuItem
            icon={<TerminalSquare className="h-3.5 w-3.5 text-amber-400" />}
            label="Terminal"
            sublabel="Interactive shell session"
            onClick={() => handleAddPanel('terminal', 'Terminal')}
          />
        </MenuSection>

        {/* Draw — figure tools (shapes, text, images) */}
        <MenuSection title="Draw">
          {DRAW_TOOLS.map(({ tool, label, icon: Icon }) => (
            <MenuItem
              key={tool}
              icon={<Icon className="h-3.5 w-3.5 text-sky-400" />}
              label={label}
              sublabel="Add a figure to the canvas"
              onClick={() => {
                setDrawingTool(tool)
                onClose()
              }}
            />
          ))}
        </MenuSection>

        {/* Applications section */}
        {applications.length > 0 && (
          <MenuSection title="Applications">
            {applications.map((app) => (
              <MenuItem
                key={app.workflowId}
                icon={<AppWindow className="h-3.5 w-3.5 text-green-400" />}
                label={app.name}
                sublabel={app.description || app.status}
                onClick={() => handleAddPanel('app', app.name, app.workflowId)}
              />
            ))}
          </MenuSection>
        )}

        {/* Quick add (generic app panel, only if no apps available) */}
        {applications.length === 0 && (
          <MenuSection title="Quick Add">
            <MenuItem
              icon={<Monitor className="h-3.5 w-3.5 text-green-400" />}
              label="Application Panel"
              onClick={() => handleAddPanel('app', 'Application')}
            />
          </MenuSection>
        )}

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
            {activeSessions.map(({ taskId, messageCount }) => {
              const task = tasks.find((t) => t.id === taskId)
              return (
                <MenuItem
                  key={taskId}
                  icon={<MessageSquare className="h-3.5 w-3.5 text-teal-400" />}
                  label={task?.title || `Session ${taskId.slice(0, 8)}`}
                  sublabel={`${messageCount} messages`}
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
        {availableTasks.length === 0 && activeSessions.length === 0 && applications.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground/40">
            No tasks, sessions, or applications available.
            <br />
            Create tasks or applications first, then add them to the canvas.
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
