import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { SkillEditDraft } from '@/types'

export function SkillDraftReview({ drafts, onReview }: {
  drafts: SkillEditDraft[]
  onReview: (name: string, decision: 'approve' | 'reject') => void
}) {
  if (drafts.length === 0) return null
  return <div className="max-w-2xl mx-auto px-8 py-6 space-y-3" data-testid="skill-draft-review">
    <h2 className="font-medium">Skill drafts for review</h2>
    {drafts.map((draft) => <div key={draft.name} className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-medium">{draft.name}</span>
        <Badge variant={draft.status === 'held' ? 'red' : 'teal'}>
          {draft.status === 'held' ? 'Guard held' : 'Ready for curator review'}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{draft.data.description}</p>
      {draft.guardCodes.length > 0 && <p className="text-xs text-destructive">Guard: {draft.guardCodes.join(', ')}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={draft.status !== 'ready_for_review'} onClick={() => onReview(draft.name, 'approve')}>Approve</Button>
        <Button size="sm" variant="ghost" onClick={() => onReview(draft.name, 'reject')}>Reject</Button>
      </div>
    </div>)}
  </div>
}
