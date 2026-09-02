import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, FileCheck2, Files } from 'lucide-react'
import { ArtifactType, type Artifact, type ArtifactApi } from '@shared/artifacts'
import {
  ARTIFACT_COPY_LABELS,
  ArtifactCopyOutcome,
  copyArtifactContent,
  copyFileOutcomeFor,
  copyText
} from '@/lib/artifact-clipboard'
import { cn } from '@/lib/utils'

export const ARTIFACT_COPY_FEEDBACK_MS = 2000

enum CopyAction {
  CONTENT = 'content',
  FILE = 'file'
}

export interface ArtifactCopyActionsProps {
  artifact: Artifact
  artifactApi: ArtifactApi
  className?: string
}

/**
 * Two explicit options for the artifact on screen: copy what it contains, or
 * copy the file itself so the user can paste it somewhere else.
 */
export function ArtifactCopyActions({ artifact, artifactApi, className }: ArtifactCopyActionsProps) {
  const [result, setResult] = useState<{ action: CopyAction; outcome: ArtifactCopyOutcome } | null>(null)
  const [busy, setBusy] = useState<CopyAction | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    setResult(null)
    setBusy(null)
  }, [artifact.id])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  const report = useCallback((action: CopyAction, outcome: ArtifactCopyOutcome) => {
    setResult({ action, outcome })
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setResult(null), ARTIFACT_COPY_FEEDBACK_MS)
  }, [])

  const run = useCallback(async (action: CopyAction, task: () => Promise<ArtifactCopyOutcome>) => {
    setBusy(action)
    try {
      report(action, await task())
    } catch {
      report(action, ArtifactCopyOutcome.FAILED)
    } finally {
      setBusy(null)
    }
  }, [report])

  const handleCopyContent = useCallback(() => {
    void run(CopyAction.CONTENT, async () => {
      // A pull request has no workspace file. Its link is its content.
      if (!artifact.path) {
        if (!artifact.url) return ArtifactCopyOutcome.FAILED
        return (await copyText(artifact.url)) ? ArtifactCopyOutcome.COPIED_CONTENT : ArtifactCopyOutcome.FAILED
      }
      return copyArtifactContent(await artifactApi.read(artifact.taskId, artifact.path))
    })
  }, [artifact.path, artifact.taskId, artifact.url, artifactApi, run])

  const handleCopyFile = useCallback(() => {
    void run(CopyAction.FILE, async () => {
      if (!artifact.path || !artifactApi.copyFile) return ArtifactCopyOutcome.FAILED
      const outcome = await artifactApi.copyFile(artifact.taskId, artifact.path)
      return copyFileOutcomeFor(outcome.mode)
    })
  }, [artifact.path, artifact.taskId, artifactApi, run])

  const canCopyFile = !!artifact.path && !!artifactApi.copyFile && artifact.type !== ArtifactType.PR
  const contentLabel = artifact.path ? 'Copy content' : 'Copy link'
  const contentResult = result?.action === CopyAction.CONTENT ? result.outcome : null
  const fileResult = result?.action === CopyAction.FILE ? result.outcome : null

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <CopyButton
        label={contentLabel}
        shortLabel="Copy"
        icon={Copy}
        doneIcon={Check}
        outcome={contentResult}
        busy={busy === CopyAction.CONTENT}
        onClick={handleCopyContent}
      />
      {canCopyFile && (
        <CopyButton
          label="Copy file"
          shortLabel="File"
          icon={Files}
          doneIcon={FileCheck2}
          outcome={fileResult}
          busy={busy === CopyAction.FILE}
          onClick={handleCopyFile}
        />
      )}
    </div>
  )
}

function CopyButton({
  label,
  shortLabel,
  icon: Icon,
  doneIcon: DoneIcon,
  outcome,
  busy,
  onClick
}: {
  label: string
  shortLabel: string
  icon: typeof Copy
  doneIcon: typeof Copy
  outcome: ArtifactCopyOutcome | null
  busy: boolean
  onClick: () => void
}) {
  const failed = outcome === ArtifactCopyOutcome.FAILED
  const done = !!outcome && !failed
  const ActiveIcon = done ? DoneIcon : Icon
  const text = outcome ? ARTIFACT_COPY_LABELS[outcome] : shortLabel

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={onClick}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors disabled:opacity-60',
        done && 'text-emerald-500',
        failed && 'text-destructive',
        !outcome && 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <ActiveIcon className="h-3.5 w-3.5" />
      <span>{text}</span>
    </button>
  )
}
