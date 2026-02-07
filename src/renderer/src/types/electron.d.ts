import type {
  WorkfloTask,
  CreateTaskDTO,
  UpdateTaskDTO,
  FileAttachment,
  Agent,
  CreateAgentDTO,
  UpdateAgentDTO
} from './index'

export interface AgentSessionStartResult {
  sessionId: string
}

export interface AgentSessionSuccessResult {
  success: boolean
}

export interface AgentOutputEvent {
  sessionId: string
  type: 'message' | 'error' | 'status'
  data: unknown
}

export interface AgentStatusEvent {
  sessionId: string
  agentId: string
  taskId: string
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
}

export interface AgentApprovalRequest {
  sessionId: string
  action: string
  description: string
}

interface ElectronAPI {
  db: {
    getTasks: () => Promise<WorkfloTask[]>
    getTask: (id: string) => Promise<WorkfloTask | undefined>
    createTask: (data: CreateTaskDTO) => Promise<WorkfloTask>
    updateTask: (id: string, data: UpdateTaskDTO) => Promise<WorkfloTask | undefined>
    deleteTask: (id: string) => Promise<boolean>
  }
  agents: {
    getAll: () => Promise<Agent[]>
    get: (id: string) => Promise<Agent | undefined>
    create: (data: CreateAgentDTO) => Promise<Agent>
    update: (id: string, data: UpdateAgentDTO) => Promise<Agent | undefined>
    delete: (id: string) => Promise<boolean>
  }
  agentSession: {
    start: (agentId: string, taskId: string) => Promise<AgentSessionStartResult>
    stop: (sessionId: string) => Promise<AgentSessionSuccessResult>
    send: (sessionId: string, message: string) => Promise<AgentSessionSuccessResult>
    approve: (sessionId: string, approved: boolean, message?: string) => Promise<AgentSessionSuccessResult>
  }
  agentConfig: {
    getProviders: () => Promise<{ providers: any[]; default: Record<string, string> } | null>
  }
  attachments: {
    pick: () => Promise<string[]>
    save: (taskId: string, filePath: string) => Promise<FileAttachment>
    remove: (taskId: string, attachmentId: string) => Promise<void>
    open: (taskId: string, attachmentId: string) => Promise<void>
  }
  notifications: {
    show: (title: string, body: string) => Promise<void>
  }
  onOverdueCheck: (callback: () => void) => () => void
  onAgentOutput: (callback: (event: AgentOutputEvent) => void) => () => void
  onAgentStatus: (callback: (event: AgentStatusEvent) => void) => () => void
  onAgentApproval: (callback: (event: AgentApprovalRequest) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
