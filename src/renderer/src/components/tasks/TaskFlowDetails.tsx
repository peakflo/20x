import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import type { WorkfloTask } from '@/types'

export function TaskFlowDetails({ task, repeatCount, onProposeFlow }: {
  task: WorkfloTask
  repeatCount: number
  onProposeFlow: () => void
}) {
  return <>
    {repeatCount >= 3 && <>
      <span className="text-muted-foreground">Repeated tasks</span>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{repeatCount} completed uses with this agent</p>
        <Button size="sm" variant="outline" onClick={onProposeFlow}>Propose flow candidate</Button>
      </div>
    </>}
    {(task.server_flow_uses?.length ?? 0) > 0 && <>
      <span className="text-muted-foreground">Learned flow</span>
      <div className="space-y-2" data-testid="task-flow-uses">
        {task.server_flow_uses!.map((use) => <div key={use.id} className="rounded-md border p-2 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <strong>Version {use.version}</strong>
            <Badge variant={use.status === 'active' ? 'green' : 'yellow'}>{use.status ?? 'unknown'}</Badge>
            <span>{use.runStatus ?? 'pending'}</span>
          </div>
          {use.judgeDecisions.map((decision, index) => <div key={`${decision.questionId}-${index}`} className="text-muted-foreground">
            Judge {decision.questionId}: {decision.verdict}
            {decision.score !== null ? ` (${decision.score})` : ''}
            {decision.judgeVersion ? ` · ${decision.judgeVersion}` : ''}
          </div>)}
          {task.feedback_rating && use.id === task.server_flow_uses!.at(-1)?.id &&
            <div>Rating {task.feedback_rating}/5 · linked to this flow use</div>}
        </div>)}
      </div>
    </>}
  </>
}
