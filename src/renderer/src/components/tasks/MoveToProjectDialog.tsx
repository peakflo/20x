import { useEffect } from 'react'
import { Check, FolderInput, Inbox } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/Dialog'
import { VisuallyHidden } from '@/components/ui/VisuallyHidden'
import { useProjectStore } from '@/stores/project-store'

interface MoveToProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The task's current project_id, or null if it's unfiled (Inbox). */
  currentProjectId: string | null
  /** Called with the chosen project id, or null to move the task back to Inbox. */
  onMove: (projectId: string | null) => void
}

export function MoveToProjectDialog({ open, onOpenChange, currentProjectId, onMove }: MoveToProjectDialogProps) {
  const projects = useProjectStore((s) => s.projects)
  const fetchProjects = useProjectStore((s) => s.fetchProjects)

  // TaskWorkspace can render standalone (canvas panel, full task view) without
  // the Sidebar ever mounting, so the project list may not be loaded yet —
  // fetch it ourselves whenever the dialog opens rather than assuming it is.
  useEffect(() => {
    if (open) fetchProjects()
  }, [open, fetchProjects])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0">
        <VisuallyHidden>
          <DialogTitle>Move to Project</DialogTitle>
        </VisuallyHidden>
        <div className="flex items-center gap-2 px-5 pt-5 pb-4">
          <FolderInput className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Move to project</span>
        </div>

        <div className="border-t border-border max-h-80 overflow-y-auto">
          <button
            onClick={() => onMove(null)}
            className="flex w-full items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-accent cursor-pointer border-b border-border"
          >
            <span className="flex items-center gap-2 text-foreground">
              <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
              Inbox (no project)
            </span>
            {currentProjectId === null && <Check className="h-3.5 w-3.5 text-primary" />}
          </button>

          {projects.map((project, i) => (
            <button
              key={project.id}
              onClick={() => onMove(project.id)}
              className={`flex w-full items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-accent cursor-pointer ${
                i < projects.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <span className="flex min-w-0 items-center gap-2 text-foreground">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
                <span className="truncate">{project.name}</span>
              </span>
              {currentProjectId === project.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          ))}

          {projects.length === 0 && (
            <div className="px-5 py-4 text-xs text-muted-foreground">
              No projects yet — create one from the sidebar first.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
