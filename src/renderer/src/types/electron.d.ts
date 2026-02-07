import type {
  WorkfloTask,
  CreateTaskDTO,
  UpdateTaskDTO,
  FileAttachment,
  Agent,
  CreateAgentDTO,
  UpdateAgentDTO
} from './index'

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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
