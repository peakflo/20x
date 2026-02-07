import type { WorkfloTask, CreateTaskDTO, UpdateTaskDTO, FileAttachment, Agent, CreateAgentDTO, UpdateAgentDTO } from '@/types'

export const taskApi = {
  getAll: (): Promise<WorkfloTask[]> => {
    return window.electronAPI.db.getTasks()
  },

  getById: (id: string): Promise<WorkfloTask | undefined> => {
    return window.electronAPI.db.getTask(id)
  },

  create: (data: CreateTaskDTO): Promise<WorkfloTask> => {
    return window.electronAPI.db.createTask(data)
  },

  update: (id: string, data: UpdateTaskDTO): Promise<WorkfloTask | undefined> => {
    return window.electronAPI.db.updateTask(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.db.deleteTask(id)
  }
}

export const agentApi = {
  getAll: (): Promise<Agent[]> => {
    return window.electronAPI.agents.getAll()
  },

  getById: (id: string): Promise<Agent | undefined> => {
    return window.electronAPI.agents.get(id)
  },

  create: (data: CreateAgentDTO): Promise<Agent> => {
    return window.electronAPI.agents.create(data)
  },

  update: (id: string, data: UpdateAgentDTO): Promise<Agent | undefined> => {
    return window.electronAPI.agents.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.agents.delete(id)
  }
}

export const notificationApi = {
  show: (title: string, body: string): Promise<void> => {
    return window.electronAPI.notifications.show(title, body)
  }
}

export const onOverdueCheck = (callback: () => void): (() => void) => {
  return window.electronAPI.onOverdueCheck(callback)
}

export const attachmentApi = {
  pick: (): Promise<string[]> => {
    return window.electronAPI.attachments.pick()
  },

  save: (taskId: string, filePath: string): Promise<FileAttachment> => {
    return window.electronAPI.attachments.save(taskId, filePath)
  },

  remove: (taskId: string, attachmentId: string): Promise<void> => {
    return window.electronAPI.attachments.remove(taskId, attachmentId)
  },

  open: (taskId: string, attachmentId: string): Promise<void> => {
    return window.electronAPI.attachments.open(taskId, attachmentId)
  }
}
