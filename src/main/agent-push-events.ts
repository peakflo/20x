import { pushEventForStatus, type PushEvent } from '../shared/push-notifications'

export interface QuestionPart {
  id?: string
  partType?: string
  update?: boolean
  tool?: { name?: string; requestId?: string; status?: string }
}

export class AgentPushEvents {
  private seenQuestions = new Map<string, Set<string>>()
  private pendingQuestion = new Set<string>()

  questionStarted(sessionId: string, part: QuestionPart): boolean {
    const name = part.tool?.name
    if (name !== 'question' && name !== 'AskUserQuestion' && (part.partType !== 'question' || name === 'permission')) return false
    if (part.update || ['completed', 'cancelled', 'error', 'failed'].includes(part.tool?.status ?? '')) return false
    const id = part.tool?.requestId || part.id
    if (!id) return false
    let seen = this.seenQuestions.get(sessionId)
    if (!seen) {
      seen = new Set()
      this.seenQuestions.set(sessionId, seen)
    }
    if (seen.has(id)) return false
    if (seen.size >= 256) seen.delete(seen.values().next().value!)
    seen.add(id)
    this.pendingQuestion.add(sessionId)
    return true
  }

  statusChanged(sessionId: string, previous: string | undefined, current: string): PushEvent | null {
    if (current === 'working' && previous !== 'working') this.pendingQuestion.delete(sessionId)
    const event = pushEventForStatus(previous, current)
    if (this.pendingQuestion.has(sessionId) && (event === 'finished' || event === 'approval')) return null
    return event
  }

  hasPendingQuestion(sessionId: string): boolean {
    return this.pendingQuestion.has(sessionId)
  }
}
