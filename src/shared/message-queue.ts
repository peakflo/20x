export interface QueuedMessageAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
}

export interface QueuedMessage {
  id: string
  task_id: string
  text: string
  attachments: QueuedMessageAttachment[]
  position: number
  created_at: string
}

export interface MessageQueueSnapshot {
  messages: QueuedMessage[]
  paused: boolean
}

export function resolveFollowupAction(defaultAction: 'steer' | 'queue', canSteer: boolean, alternate = false): 'steer' | 'queue' {
  if (!canSteer) return 'queue'
  return alternate ? (defaultAction === 'queue' ? 'steer' : 'queue') : defaultAction
}
