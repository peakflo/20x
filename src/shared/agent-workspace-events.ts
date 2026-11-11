/** Workspace changes reported by an agent without adding transcript messages. */
export type AgentWorkspaceEvent =
  | { taskId: string; kind: 'vcs' }
  | { taskId: string; kind: 'published_change'; url: string; repo?: string; identifier?: string }
