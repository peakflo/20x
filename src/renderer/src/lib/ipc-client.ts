import type { WorkfloTask, CreateTaskDTO, UpdateTaskDTO, FileAttachment, Agent, CreateAgentDTO, UpdateAgentDTO, McpServer, CreateMcpServerDTO, UpdateMcpServerDTO, Skill, CreateSkillDTO, UpdateSkillDTO, TaskSource, CreateTaskSourceDTO, UpdateTaskSourceDTO, SyncResult, PluginMeta, ConfigFieldSchema, ConfigFieldOption, PluginAction, ActionResult, SourceUser, ReassignResult } from '@/types'
import type { AgentOutputEvent, AgentStatusEvent, AgentApprovalRequest, GhCliStatus, GitHubRepo, WorktreeProgressEvent, McpTestResult, SkillSyncResult, DepsStatus } from '@/types/electron'

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

export const mcpServerApi = {
  getAll: (): Promise<McpServer[]> => {
    return window.electronAPI.mcpServers.getAll()
  },

  getById: (id: string): Promise<McpServer | undefined> => {
    return window.electronAPI.mcpServers.get(id)
  },

  create: (data: CreateMcpServerDTO): Promise<McpServer> => {
    return window.electronAPI.mcpServers.create(data)
  },

  update: (id: string, data: UpdateMcpServerDTO): Promise<McpServer | undefined> => {
    return window.electronAPI.mcpServers.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.mcpServers.delete(id)
  },

  testConnection: (data: { id?: string; name: string; type?: 'local' | 'remote'; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }): Promise<McpTestResult> => {
    return window.electronAPI.mcpServers.testConnection(data)
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

export const agentSessionApi = {
  start: (agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<{ sessionId: string }> => {
    return window.electronAPI.agentSession.start(agentId, taskId, workspaceDir, skipInitialPrompt)
  },

  resume: (agentId: string, taskId: string, ocSessionId: string): Promise<{ sessionId: string }> => {
    return window.electronAPI.agentSession.resume(agentId, taskId, ocSessionId)
  },

  abort: (sessionId: string): Promise<{ success: boolean }> => {
    return window.electronAPI.agentSession.abort(sessionId)
  },

  stop: (sessionId: string): Promise<{ success: boolean }> => {
    return window.electronAPI.agentSession.stop(sessionId)
  },

  send: (sessionId: string, message: string, taskId?: string): Promise<{ success: boolean; newSessionId?: string }> => {
    return window.electronAPI.agentSession.send(sessionId, message, taskId)
  },

  approve: (sessionId: string, approved: boolean, message?: string): Promise<{ success: boolean }> => {
    return window.electronAPI.agentSession.approve(sessionId, approved, message)
  },

  syncSkills: (sessionId: string): Promise<SkillSyncResult> => {
    return window.electronAPI.agentSession.syncSkills(sessionId)
  },

  syncSkillsForTask: (taskId: string): Promise<SkillSyncResult> => {
    return window.electronAPI.agentSession.syncSkillsForTask(taskId)
  },

  learnFromSession: (sessionId: string, message: string): Promise<SkillSyncResult> => {
    return window.electronAPI.agentSession.learnFromSession(sessionId, message)
  }
}

export const agentConfigApi = {
  getProviders: (serverUrl?: string): Promise<{ providers: any[]; default: Record<string, string> } | null> => {
    return window.electronAPI.agentConfig.getProviders(serverUrl)
  }
}

export const shellApi = {
  openPath: (filePath: string): Promise<void> => {
    return window.electronAPI.shell.openPath(filePath)
  },
  showItemInFolder: (filePath: string): Promise<void> => {
    return window.electronAPI.shell.showItemInFolder(filePath)
  },
  readTextFile: (filePath: string): Promise<{ content: string; size: number } | null> => {
    return window.electronAPI.shell.readTextFile(filePath)
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
  },

  download: (taskId: string, attachmentId: string): Promise<void> => {
    return window.electronAPI.attachments.download(taskId, attachmentId)
  }
}

export const onAgentOutput = (callback: (event: AgentOutputEvent) => void): (() => void) => {
  return window.electronAPI.onAgentOutput(callback)
}

export const onAgentStatus = (callback: (event: AgentStatusEvent) => void): (() => void) => {
  return window.electronAPI.onAgentStatus(callback)
}

export const onAgentApproval = (callback: (event: AgentApprovalRequest) => void): (() => void) => {
  return window.electronAPI.onAgentApproval(callback)
}

export const onAgentIncompatibleSession = (callback: (event: { taskId: string; agentId: string; error: string }) => void): (() => void) => {
  return window.electronAPI.onAgentIncompatibleSession(callback)
}

export const onTaskUpdated = (callback: (event: { taskId: string; updates: Partial<WorkfloTask> }) => void): (() => void) => {
  return window.electronAPI.onTaskUpdated(callback)
}

export const settingsApi = {
  get: (key: string): Promise<string | null> => {
    return window.electronAPI.settings.get(key)
  },
  set: (key: string, value: string): Promise<void> => {
    return window.electronAPI.settings.set(key, value)
  },
  getAll: (): Promise<Record<string, string>> => {
    return window.electronAPI.settings.getAll()
  }
}

export const githubApi = {
  checkCli: (): Promise<GhCliStatus> => {
    return window.electronAPI.github.checkCli()
  },
  startAuth: (): Promise<void> => {
    return window.electronAPI.github.startAuth()
  },
  fetchOrgs: (): Promise<string[]> => {
    return window.electronAPI.github.fetchOrgs()
  },
  fetchOrgRepos: (org: string): Promise<GitHubRepo[]> => {
    return window.electronAPI.github.fetchOrgRepos(org)
  }
}

export const taskSourceApi = {
  getAll: (): Promise<TaskSource[]> => {
    return window.electronAPI.taskSources.getAll()
  },

  getById: (id: string): Promise<TaskSource | undefined> => {
    return window.electronAPI.taskSources.get(id)
  },

  create: (data: CreateTaskSourceDTO): Promise<TaskSource> => {
    return window.electronAPI.taskSources.create(data)
  },

  update: (id: string, data: UpdateTaskSourceDTO): Promise<TaskSource | undefined> => {
    return window.electronAPI.taskSources.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.taskSources.delete(id)
  },

  sync: (sourceId: string): Promise<SyncResult> => {
    return window.electronAPI.taskSources.sync(sourceId)
  },

  exportUpdate: (taskId: string, fields: Record<string, unknown>): Promise<void> => {
    return window.electronAPI.taskSources.exportUpdate(taskId, fields)
  },

  getUsers: (sourceId: string): Promise<SourceUser[]> => {
    return window.electronAPI.taskSources.getUsers(sourceId)
  },

  reassign: (taskId: string, userIds: string[], assigneeDisplay: string): Promise<ReassignResult> => {
    return window.electronAPI.taskSources.reassign(taskId, userIds, assigneeDisplay)
  }
}

export const skillApi = {
  getAll: (): Promise<Skill[]> => {
    return window.electronAPI.skills.getAll()
  },

  getById: (id: string): Promise<Skill | undefined> => {
    return window.electronAPI.skills.get(id)
  },

  create: (data: CreateSkillDTO): Promise<Skill> => {
    return window.electronAPI.skills.create(data)
  },

  update: (id: string, data: UpdateSkillDTO): Promise<Skill | undefined> => {
    return window.electronAPI.skills.update(id, data)
  },

  delete: (id: string): Promise<boolean> => {
    return window.electronAPI.skills.delete(id)
  }
}

export const depsApi = {
  check: (): Promise<DepsStatus> => window.electronAPI.deps.check()
}

export const pluginApi = {
  list: (): Promise<PluginMeta[]> => {
    return window.electronAPI.plugins.list()
  },

  getConfigSchema: (pluginId: string): Promise<ConfigFieldSchema[]> => {
    return window.electronAPI.plugins.getConfigSchema(pluginId)
  },

  getDocumentation: (pluginId: string): Promise<string | null> => {
    return window.electronAPI.plugins.getDocumentation(pluginId)
  },

  resolveOptions: (pluginId: string, resolverKey: string, config: Record<string, unknown>, mcpServerId?: string, sourceId?: string): Promise<ConfigFieldOption[]> => {
    return window.electronAPI.plugins.resolveOptions(pluginId, resolverKey, config, mcpServerId, sourceId)
  },

  getActions: (pluginId: string, config: Record<string, unknown>): Promise<PluginAction[]> => {
    return window.electronAPI.plugins.getActions(pluginId, config)
  },

  executeAction: (actionId: string, taskId: string, sourceId: string, input?: string): Promise<ActionResult> => {
    return window.electronAPI.plugins.executeAction(actionId, taskId, sourceId, input)
  }
}

export const worktreeApi = {
  setup: (taskId: string, repos: { fullName: string; defaultBranch: string }[], org: string): Promise<string> => {
    return window.electronAPI.worktree.setup(taskId, repos, org)
  },
  cleanup: (taskId: string, repos: { fullName: string }[], org: string, removeTaskDir?: boolean): Promise<void> => {
    return window.electronAPI.worktree.cleanup(taskId, repos, org, removeTaskDir)
  }
}

export const onWorktreeProgress = (callback: (event: WorktreeProgressEvent) => void): (() => void) => {
  return window.electronAPI.onWorktreeProgress(callback)
}
