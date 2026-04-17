/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentManager } from './agent-manager'
import { SessionStatus, TaskStatus } from '../shared/constants'
import { MessagePartType, MessageRole } from './adapters/coding-agent-adapter'

// Mock filesystem operations
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  }
})
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}))

// Mock heavy dependencies to avoid loading electron/native modules
vi.mock('child_process', () => ({ spawn: vi.fn() }))
const notificationInstances: Array<{ show: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; _listeners: Map<string, () => void>; opts: { title: string; body: string } }> = []

vi.mock('electron', () => {
  class MockNotification {
    show = vi.fn()
    on = vi.fn((event: string, cb: () => void) => { this._listeners.set(event, cb) })
    _listeners = new Map<string, () => void>()
    constructor(public opts: { title: string; body: string }) {
      notificationInstances.push(this)
    }
    static isSupported = vi.fn(() => true)
  }
  return {
    app: { getPath: vi.fn(() => '/tmp') },
    Notification: MockNotification,
  }
})
vi.mock('./adapters/opencode-adapter', () => ({ OpencodeAdapter: vi.fn() }))
vi.mock('./adapters/claude-code-adapter', () => ({ ClaudeCodeAdapter: vi.fn() }))
vi.mock('./adapters/acp-adapter', () => ({ AcpAdapter: vi.fn() }))
vi.mock('./task-api-server', () => ({ getTaskApiPort: vi.fn(), waitForTaskApiServer: vi.fn() }))
vi.mock('./secret-broker', () => ({
  registerSecretSession: vi.fn(),
  unregisterSecretSession: vi.fn(),
  getSecretBrokerPort: vi.fn(),
  writeSecretShellWrapper: vi.fn(),
}))

import { mkdir as mkdirAsync, writeFile as writeFileAsync } from 'fs/promises'
import { existsSync, copyFileSync, mkdirSync } from 'fs'

const mockedMkdirAsync = vi.mocked(mkdirAsync)
const mockedWriteFileAsync = vi.mocked(writeFileAsync)
const mockedExistsSync = vi.mocked(existsSync)
const mockedCopyFileSync = vi.mocked(copyFileSync)
const mockedMkdirSync = vi.mocked(mkdirSync)

function makeSkillRecord(overrides: Partial<{
  id: string; name: string; description: string; content: string;
  confidence: number; uses: number; last_used: string; tags: string[];
  version: number; is_deleted: boolean; created_at: string; updated_at: string;
}> = {}) {
  return {
    id: 'skill-1',
    name: 'test-skill',
    description: 'A test skill',
    content: '# Test\nDo the thing.',
    confidence: 0.9,
    uses: 3,
    last_used: '2026-03-06',
    tags: ['testing'],
    version: 1,
    is_deleted: false,
    created_at: '2026-03-01',
    updated_at: '2026-03-06',
    ...overrides,
  }
}

function createMockDb(agentConfig: Record<string, unknown> = {}) {
  return {
    getTask: vi.fn(() => ({
      id: 'task-1',
      title: 'Test Task',
      repos: ['org/repo'],
      skill_ids: ['skill-1'],
    })),
    getAgent: vi.fn(() => ({
      id: 'agent-1',
      name: 'Test Agent',
      config: agentConfig,
    })),
    getSkills: vi.fn(() => [makeSkillRecord()]),
    getSkillsByIds: vi.fn(() => [makeSkillRecord()]),
    getSkillByName: vi.fn(() => null),
    getMcpServer: vi.fn(() => null),
    getSecretsByIds: vi.fn(() => []),
    getSetting: vi.fn(() => null),
  } as unknown as ConstructorParameters<typeof AgentManager>[0]
}

let manager: AgentManager

describe('AgentManager skill file paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('writeSkillFiles', () => {
    it('writes SKILL.md files to .claude/skills/ for Claude Code agents', async () => {
      const mockDb = createMockDb({ coding_agent: 'claude-code' })
      manager = new AgentManager(mockDb)

      const workspaceDir = '/tmp/test-workspace'
      await (manager as any).writeSkillFiles('task-1', 'agent-1', workspaceDir)

      // Verify SKILL.md was written under .claude/skills/ (now uses async fs/promises)
      const mkdirCalls = mockedMkdirAsync.mock.calls.map(c => c[0])
      expect(mkdirCalls).toContainEqual('/tmp/test-workspace/.claude/skills/test-skill')

      const writeFilePaths = mockedWriteFileAsync.mock.calls.map(c => c[0] as string)
      expect(writeFilePaths).toContainEqual(
        '/tmp/test-workspace/.claude/skills/test-skill/SKILL.md'
      )

      // Verify it was NOT written to .agents/skills/
      const agentsWrites = writeFilePaths.filter(p => p.includes('.agents/skills/'))
      expect(agentsWrites).toHaveLength(0)
    })

    it('writes SKILL.md files to .agents/skills/ for OpenCode agents', async () => {
      const mockDb = createMockDb({ coding_agent: 'opencode' })
      manager = new AgentManager(mockDb)

      const workspaceDir = '/tmp/test-workspace'
      await (manager as any).writeSkillFiles('task-1', 'agent-1', workspaceDir)

      const writeFilePaths = mockedWriteFileAsync.mock.calls.map(c => c[0] as string)
      expect(writeFilePaths).toContainEqual(
        '/tmp/test-workspace/.agents/skills/test-skill/SKILL.md'
      )

      // Verify it was NOT written to .claude/skills/
      const claudeWrites = writeFilePaths.filter(p => p.includes('.claude/skills/'))
      expect(claudeWrites).toHaveLength(0)
    })

    it('writes SKILL.md files to .agents/skills/ for Codex agents', async () => {
      const mockDb = createMockDb({ coding_agent: 'codex' })
      manager = new AgentManager(mockDb)

      const workspaceDir = '/tmp/test-workspace'
      await (manager as any).writeSkillFiles('task-1', 'agent-1', workspaceDir)

      const writeFilePaths = mockedWriteFileAsync.mock.calls.map(c => c[0] as string)
      expect(writeFilePaths).toContainEqual(
        '/tmp/test-workspace/.agents/skills/test-skill/SKILL.md'
      )

      // Verify it was NOT written to .claude/skills/
      const claudeWrites = writeFilePaths.filter(p => p.includes('.claude/skills/'))
      expect(claudeWrites).toHaveLength(0)
    })

    it('defaults to .agents/skills/ when no coding_agent is configured', async () => {
      const mockDb = createMockDb({})
      manager = new AgentManager(mockDb)

      const workspaceDir = '/tmp/test-workspace'
      await (manager as any).writeSkillFiles('task-1', 'agent-1', workspaceDir)

      const writeFilePaths = mockedWriteFileAsync.mock.calls.map(c => c[0] as string)
      expect(writeFilePaths).toContainEqual(
        '/tmp/test-workspace/.agents/skills/test-skill/SKILL.md'
      )
    })

    it('strips YAML-breaking characters from skill name and description in SKILL.md frontmatter', async () => {
      const mockDb = {
        ...createMockDb({ coding_agent: 'codex' }),
        getSkillsByIds: vi.fn(() => [
          makeSkillRecord({
            name: '[Workflo] gh-pr-base-branch-check',
            description: 'Check base branch {details}: see #docs',
          }),
        ]),
      } as unknown as ConstructorParameters<typeof AgentManager>[0]
      manager = new AgentManager(mockDb)

      await (manager as any).writeSkillFiles('task-1', 'agent-1', '/tmp/test-workspace')

      const writeFileCall = mockedWriteFileAsync.mock.calls.find(c =>
        (c[0] as string).endsWith('SKILL.md')
      )
      expect(writeFileCall).toBeDefined()
      const writtenContent = writeFileCall![1] as string
      // Square brackets, curly braces and hash must not appear in the frontmatter name/description lines
      const frontmatterLines = writtenContent.split('---')[1]
      expect(frontmatterLines).not.toMatch(/[\[\]{}"'#]/)
      // The sanitised values should still be readable
      expect(frontmatterLines).toContain('Workflo gh-pr-base-branch-check')
      expect(frontmatterLines).toContain('Check base branch details: see docs')
    })
  })

  describe('writeAgentsDocumentation', () => {
    it('writes AGENTS.md and CLAUDE.md to workspace root, not .agents/', async () => {
      const mockDb = createMockDb({ coding_agent: 'claude-code' })
      manager = new AgentManager(mockDb)

      const workspaceDir = '/tmp/test-workspace'
      const skills = [makeSkillRecord()]
      const repos = ['org/repo']

      await (manager as any).writeAgentsDocumentation(workspaceDir, skills, repos, 'agent-1')

      const writeFilePaths = mockedWriteFileAsync.mock.calls.map(c => c[0] as string)

      // Both files should be written to workspace root
      expect(writeFilePaths).toContain('/tmp/test-workspace/AGENTS.md')
      expect(writeFilePaths).toContain('/tmp/test-workspace/CLAUDE.md')

      // Neither should be written inside .agents/
      const agentsDirWrites = writeFilePaths.filter(
        p => p.includes('.agents/AGENTS.md') || p.includes('.agents/CLAUDE.md')
      )
      expect(agentsDirWrites).toHaveLength(0)
    })

    it('does not create .agents/ directory for documentation files', async () => {
      const mockDb = createMockDb({})
      manager = new AgentManager(mockDb)

      const workspaceDir = '/tmp/test-workspace'
      await (manager as any).writeAgentsDocumentation(workspaceDir, [], [], 'agent-1')

      // mkdir (async) should NOT be called for .agents/ directory
      const mkdirCalls = mockedMkdirAsync.mock.calls.map(c => c[0] as string)
      const agentsDirCreates = mkdirCalls.filter(p => p.endsWith('.agents'))
      expect(agentsDirCreates).toHaveLength(0)
    })
  })

  describe('generateClaudeMd', () => {
    it('generates skill links with .claude/skills/ paths', () => {
      const mockDb = createMockDb({})
      manager = new AgentManager(mockDb)

      const skills = [makeSkillRecord({ name: 'code-testing' })]
      const result: string = (manager as any).generateClaudeMd(skills, ['org/repo'], '/tmp/ws')

      // Should use .claude/skills/ paths in Quick Reference
      expect(result).toContain('(.claude/skills/code-testing/SKILL.md)')
      // Should use .claude/skills/ paths in Detailed Skills
      expect(result).toContain('[.claude/skills/code-testing/SKILL.md](.claude/skills/code-testing/SKILL.md)')
      // Should NOT use bare skills/ paths (old behavior)
      expect(result).not.toMatch(/\(skills\/code-testing\/SKILL\.md\)/)
      // Should NOT reference .agents/skills/
      expect(result).not.toContain('.agents/skills/')
    })

    it('generates valid markdown with no skills', () => {
      const mockDb = createMockDb({})
      manager = new AgentManager(mockDb)

      const result: string = (manager as any).generateClaudeMd([], ['org/repo'], '/tmp/ws')
      expect(result).toContain('No skills are available for this session.')
      expect(result).not.toContain('.claude/skills/')
      expect(result).not.toContain('.agents/skills/')
    })
  })

  describe('generateAgentsMd', () => {
    it('generates skill links with .agents/skills/ paths', () => {
      const mockDb = createMockDb({})
      manager = new AgentManager(mockDb)

      const skills = [makeSkillRecord({ name: 'code-testing' })]
      const result: string = (manager as any).generateAgentsMd(skills, ['org/repo'], '/tmp/ws')

      // Should use .agents/skills/ paths
      expect(result).toContain('(.agents/skills/code-testing/SKILL.md)')
      // Should NOT use bare skills/ paths (old behavior)
      expect(result).not.toMatch(/\(skills\/code-testing\/SKILL\.md\)/)
      // Should NOT reference .claude/skills/
      expect(result).not.toContain('.claude/skills/')
    })

    it('generates valid markdown with no skills', () => {
      const mockDb = createMockDb({})
      manager = new AgentManager(mockDb)

      const result: string = (manager as any).generateAgentsMd([], ['org/repo'], '/tmp/ws')
      expect(result).toContain('No skills configured for this session.')
      expect(result).not.toContain('.agents/skills/')
      expect(result).not.toContain('.claude/skills/')
    })
  })

  describe('getMemoryFileName', () => {
    it('returns CLAUDE.md for Claude Code agents', () => {
      const mockDb = createMockDb({ coding_agent: 'claude-code' })
      manager = new AgentManager(mockDb)

      const result: string = (manager as any).getMemoryFileName('agent-1')
      expect(result).toBe('CLAUDE.md')
    })

    it('returns AGENTS.md for OpenCode agents', () => {
      const mockDb = createMockDb({ coding_agent: 'opencode' })
      manager = new AgentManager(mockDb)

      const result: string = (manager as any).getMemoryFileName('agent-1')
      expect(result).toBe('AGENTS.md')
    })

    it('returns AGENTS.md for Codex agents', () => {
      const mockDb = createMockDb({ coding_agent: 'codex' })
      manager = new AgentManager(mockDb)

      const result: string = (manager as any).getMemoryFileName('agent-1')
      expect(result).toBe('AGENTS.md')
    })

    it('returns AGENTS.md when no coding_agent is configured', () => {
      const mockDb = createMockDb({})
      manager = new AgentManager(mockDb)

      const result: string = (manager as any).getMemoryFileName('agent-1')
      expect(result).toBe('AGENTS.md')
    })
  })
})

describe('AgentManager worktree setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedExistsSync.mockReturnValue(false)
  })

  it('sets up missing repo folders on start even while task is still triaging for GitHub', async () => {
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Triaged Task',
        repos: ['peakflo/20x'],
        status: TaskStatus.Triaging,
        session_id: null,
      })),
      getSetting: vi.fn((key: string) => {
        if (key === 'git_provider') return 'github'
        if (key === 'github_org') return 'peakflo'
        return null
      }),
      getWorkspaceDir: vi.fn(() => '/tmp/workspaces/task-1'),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    const githubManager = {
      fetchOrgRepos: vi.fn().mockResolvedValue([{ fullName: 'peakflo/20x', defaultBranch: 'main' }]),
    }
    const worktreeManager = {
      setupWorkspaceForTask: vi.fn().mockResolvedValue('/tmp/workspaces/task-1'),
    }

    manager.setManagers(githubManager as any, worktreeManager as any)

    const workspaceDir = await (manager as any).setupWorktreeIfNeeded('task-1')

    expect(workspaceDir).toBe('/tmp/workspaces/task-1')
    expect(githubManager.fetchOrgRepos).toHaveBeenCalledWith('peakflo')
    expect(worktreeManager.setupWorkspaceForTask).toHaveBeenCalledWith(
      'task-1',
      [{ fullName: 'peakflo/20x', defaultBranch: 'main' }],
      'peakflo',
      'github'
    )
  })

  it('uses GitLab repo discovery when repairing missing repo folders during triage', async () => {
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Triaged Task',
        repos: ['peakflo/20x'],
        status: TaskStatus.Triaging,
        session_id: null,
      })),
      getSetting: vi.fn((key: string) => {
        if (key === 'git_provider') return 'gitlab'
        if (key === 'github_org') return 'peakflo'
        return null
      }),
      getWorkspaceDir: vi.fn(() => '/tmp/workspaces/task-1'),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    const githubManager = {
      fetchOrgRepos: vi.fn(),
    }
    const gitlabManager = {
      fetchOrgRepos: vi.fn().mockResolvedValue([{ fullName: 'peakflo/20x', defaultBranch: 'main' }]),
    }
    const worktreeManager = {
      setupWorkspaceForTask: vi.fn().mockResolvedValue('/tmp/workspaces/task-1'),
    }

    manager.setManagers(githubManager as any, worktreeManager as any, gitlabManager as any)

    const workspaceDir = await (manager as any).setupWorktreeIfNeeded('task-1')

    expect(workspaceDir).toBe('/tmp/workspaces/task-1')
    expect(gitlabManager.fetchOrgRepos).toHaveBeenCalledWith('peakflo')
    expect(githubManager.fetchOrgRepos).not.toHaveBeenCalled()
    expect(worktreeManager.setupWorkspaceForTask).toHaveBeenCalledWith(
      'task-1',
      [{ fullName: 'peakflo/20x', defaultBranch: 'main' }],
      'peakflo',
      'gitlab'
    )
  })

  it('falls back to task repo names when fetched repo metadata does not match', async () => {
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Triaged Task',
        repos: ['peakflo/20x'],
        status: TaskStatus.Triaging,
        session_id: null,
      })),
      getSetting: vi.fn((key: string) => {
        if (key === 'git_provider') return 'github'
        if (key === 'github_org') return 'peakflo'
        return null
      }),
      getWorkspaceDir: vi.fn(() => '/tmp/workspaces/task-1'),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    const githubManager = {
      fetchOrgRepos: vi.fn().mockResolvedValue([{ fullName: 'peakflo/other-repo', defaultBranch: 'develop' }]),
    }
    const worktreeManager = {
      setupWorkspaceForTask: vi.fn().mockResolvedValue('/tmp/workspaces/task-1'),
    }

    manager.setManagers(githubManager as any, worktreeManager as any)

    const workspaceDir = await (manager as any).setupWorktreeIfNeeded('task-1')

    expect(workspaceDir).toBe('/tmp/workspaces/task-1')
    expect(worktreeManager.setupWorkspaceForTask).toHaveBeenCalledWith(
      'task-1',
      [{ fullName: 'peakflo/20x', defaultBranch: 'main' }],
      'peakflo',
      'github'
    )
  })

  it('uses configured org when task repo tag omits the org prefix', async () => {
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Triaged Task',
        repos: ['20x'],
        status: TaskStatus.Triaging,
        session_id: null,
      })),
      getSetting: vi.fn((key: string) => {
        if (key === 'git_provider') return 'github'
        if (key === 'github_org') return 'peakflo'
        return null
      }),
      getWorkspaceDir: vi.fn(() => '/tmp/workspaces/task-1'),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    const githubManager = {
      fetchOrgRepos: vi.fn().mockResolvedValue([]),
    }
    const worktreeManager = {
      setupWorkspaceForTask: vi.fn().mockResolvedValue('/tmp/workspaces/task-1'),
    }

    manager.setManagers(githubManager as any, worktreeManager as any)

    const workspaceDir = await (manager as any).setupWorktreeIfNeeded('task-1')

    expect(workspaceDir).toBe('/tmp/workspaces/task-1')
    expect(worktreeManager.setupWorkspaceForTask).toHaveBeenCalledWith(
      'task-1',
      [{ fullName: 'peakflo/20x', defaultBranch: 'main' }],
      'peakflo',
      'github'
    )
  })
})

describe('AgentManager OS notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notificationInstances.length = 0
  })

  function createManagerWithWindow(opts: { isFocused: boolean; isDestroyed?: boolean }) {
    const mockDb = createMockDb({})
    const mgr = new AgentManager(mockDb)
    const mockWindow = {
      isDestroyed: vi.fn(() => opts.isDestroyed ?? false),
      isFocused: vi.fn(() => opts.isFocused),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    }
    mgr.setMainWindow(mockWindow as any)
    return { mgr, mockWindow }
  }

  it('shows notification when status transitions from working to idle and window is not focused', () => {
    const { mgr } = createManagerWithWindow({ isFocused: false })

    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.WORKING
    })
    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.IDLE
    })

    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0].opts.title).toBe('Agent finished')
    expect(notificationInstances[0].opts.body).toContain('Test Task')
    expect(notificationInstances[0].show).toHaveBeenCalled()
  })

  it('shows notification when status transitions from working to waiting_approval and window is not focused', () => {
    const { mgr } = createManagerWithWindow({ isFocused: false })

    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.WORKING
    })
    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.WAITING_APPROVAL
    })

    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0].opts.title).toBe('Agent needs approval')
    expect(notificationInstances[0].opts.body).toContain('Test Task')
    expect(notificationInstances[0].show).toHaveBeenCalled()
  })

  it('does NOT show notification when window is focused', () => {
    const { mgr } = createManagerWithWindow({ isFocused: true })

    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.WORKING
    })
    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.IDLE
    })

    expect(notificationInstances).toHaveLength(0)
  })

  it('does NOT show notification when status does not transition from working', () => {
    const { mgr } = createManagerWithWindow({ isFocused: false })

    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.IDLE
    })
    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.IDLE
    })

    expect(notificationInstances).toHaveLength(0)
  })

  it('does NOT show notification for subtask of a completed parent task', () => {
    const mockDb = createMockDb({})
    // Override getTask to return a subtask with a completed parent
    mockDb.getTask = vi.fn((id: string) => {
      if (id === 'subtask-1') {
        return { id: 'subtask-1', title: 'Subtask', parent_task_id: 'parent-1', repos: [], skill_ids: [] }
      }
      if (id === 'parent-1') {
        return { id: 'parent-1', title: 'Parent Task', status: TaskStatus.Completed, repos: [], skill_ids: [] }
      }
      return null
    }) as any
    const mgr = new AgentManager(mockDb)
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    }
    mgr.setMainWindow(mockWindow as any)

    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'subtask-1', status: SessionStatus.WORKING
    })
    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'subtask-1', status: SessionStatus.IDLE
    })

    expect(notificationInstances).toHaveLength(0)
  })

  it('shows notification for subtask of a non-completed parent task', () => {
    const mockDb = createMockDb({})
    mockDb.getTask = vi.fn((id: string) => {
      if (id === 'subtask-1') {
        return { id: 'subtask-1', title: 'Subtask', parent_task_id: 'parent-1', repos: [], skill_ids: [] }
      }
      if (id === 'parent-1') {
        return { id: 'parent-1', title: 'Parent Task', status: TaskStatus.AgentWorking, repos: [], skill_ids: [] }
      }
      return null
    }) as any
    const mgr = new AgentManager(mockDb)
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    }
    mgr.setMainWindow(mockWindow as any)

    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'subtask-1', status: SessionStatus.WORKING
    })
    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'subtask-1', status: SessionStatus.IDLE
    })

    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0].opts.title).toBe('Agent finished')
    expect(notificationInstances[0].opts.body).toContain('Subtask')
  })

  it('clicking notification brings the window to focus', () => {
    const { mgr, mockWindow } = createManagerWithWindow({ isFocused: false })

    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.WORKING
    })
    ;(mgr as any).sendToRenderer('agent:status', {
      sessionId: 's1', agentId: 'a1', taskId: 'task-1', status: SessionStatus.IDLE
    })

    expect(notificationInstances).toHaveLength(1)
    const clickHandler = notificationInstances[0]._listeners.get('click')
    expect(clickHandler).toBeDefined()
    clickHandler!()

    expect(mockWindow.show).toHaveBeenCalled()
    expect(mockWindow.focus).toHaveBeenCalled()
  })
})

describe('AgentManager implicit resume behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('replays transcript to renderer when sendMessage implicitly resumes a session', async () => {
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Test Task',
        agent_id: 'agent-1',
        session_id: 'persisted-session-id',
      })),
      getAgent: vi.fn(() => ({
        id: 'agent-1',
        name: 'Test Agent',
        config: { coding_agent: 'codex' },
      })),
      getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
      updateTask: vi.fn(),
      getMcpServer: vi.fn(() => null),
      getSecretsByIds: vi.fn(() => []),
      getSecretsWithValues: vi.fn(() => []),
      getSetting: vi.fn(() => null),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    const adapter = {
      initialize: vi.fn(async () => undefined),
      resumeSession: vi.fn(async () => ([
        { id: 'msg-1', role: 'assistant', parts: [{ id: 'part-1', type: 'text', text: 'Hello' }] }
      ]))
    }

    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    vi.spyOn(manager as any, 'buildSecretsSystemPrompt').mockReturnValue('')

    const sendToRendererSpy = vi.spyOn(manager as any, 'sendToRenderer').mockImplementation(() => undefined)
    const doSendAdapterMessageSpy = vi.spyOn(manager as any, 'doSendAdapterMessage').mockResolvedValue(undefined)

    await manager.sendMessage('missing-live-session', 'root cause ?', 'task-1', 'agent-1')

    expect(adapter.resumeSession).toHaveBeenCalledOnce()
    expect(doSendAdapterMessageSpy).toHaveBeenCalledOnce()

    // Implicit resume now replays messages to renderer to prevent context loss
    // after idle periods on both mobile and desktop
    const outputBatchEvents = sendToRendererSpy.mock.calls.filter(([channel]) => channel === 'agent:output-batch')
    expect(outputBatchEvents).toHaveLength(1)
    expect((outputBatchEvents[0][1] as { messages: { content: string }[] }).messages).toHaveLength(1)
    expect((outputBatchEvents[0][1] as { messages: { content: string }[] }).messages[0].content).toBe('Hello')
  })

  it('still replays transcript during explicit resume', async () => {
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Test Task',
      })),
      getAgent: vi.fn(() => ({
        id: 'agent-1',
        name: 'Test Agent',
        config: { coding_agent: 'codex' },
      })),
      getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
      updateTask: vi.fn(),
      getMcpServer: vi.fn(() => null),
      getSecretsByIds: vi.fn(() => []),
      getSecretsWithValues: vi.fn(() => []),
      getSetting: vi.fn(() => null),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    const adapter = {
      initialize: vi.fn(async () => undefined),
      resumeSession: vi.fn(async () => ([{
        id: 'msg-1',
        role: MessageRole.ASSISTANT,
        parts: [{ id: 'part-1', type: MessagePartType.TEXT, text: 'Earlier reply' }]
      }]))
    }

    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
    vi.spyOn(manager as any, 'buildSecretsSystemPrompt').mockReturnValue('')

    const sendToRendererSpy = vi.spyOn(manager as any, 'sendToRenderer').mockImplementation(() => undefined)

    await manager.resumeSession('agent-1', 'task-1', 'persisted-session-id')

    const outputBatchEvents = sendToRendererSpy.mock.calls.filter(([channel]) => channel === 'agent:output-batch')
    expect(outputBatchEvents).toHaveLength(1)
  })
})

describe('AgentManager transitionToIdle — enterprise task completion after feedback', () => {
  function createEnterpriseTaskDb(taskOverrides: Record<string, unknown> = {}) {
    const task = {
      id: 'task-1',
      title: 'Enterprise Task',
      repos: [],
      skill_ids: [],
      status: TaskStatus.AgentLearning,
      source_id: 'source-1',
      output_fields: [],
      ...taskOverrides,
    }
    return {
      getTask: vi.fn(() => task),
      getAgent: vi.fn(() => ({ id: 'agent-1', name: 'Test Agent', config: {} })),
      getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
      getSkills: vi.fn(() => []),
      getSkillsByIds: vi.fn(() => []),
      getSkillByName: vi.fn(() => null),
      getMcpServer: vi.fn(() => null),
      getSecretsByIds: vi.fn(() => []),
      getSetting: vi.fn(() => null),
      updateTask: vi.fn(),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]
  }

  function setupManager(mockDb: ReturnType<typeof createEnterpriseTaskDb>) {
    const mgr = new AgentManager(mockDb)
    // Mock sendToRenderer
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    // Mock syncSkillsFromWorkspace
    vi.spyOn(mgr as any, 'syncSkillsFromWorkspace').mockResolvedValue(undefined)
    // Create a session in working state
    const session = {
      id: 'session-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
    }
    ;(mgr as any).sessions.set('session-1', session)
    return { mgr, session }
  }

  it('calls executeAction for enterprise tasks (source_id) before completing', async () => {
    const mockDb = createEnterpriseTaskDb()
    const { mgr, session } = setupManager(mockDb)

    const mockSyncManager = {
      executeAction: vi.fn().mockResolvedValue({ success: true, taskUpdate: { status: TaskStatus.Completed } }),
    }
    mgr.setSyncManager(mockSyncManager as any)

    await (mgr as any).transitionToIdle('session-1', session)

    // executeAction should be called with default 'complete' action
    expect(mockSyncManager.executeAction).toHaveBeenCalledWith(
      'complete',
      expect.objectContaining({ id: 'task-1', source_id: 'source-1' }),
      undefined,
      'source-1'
    )

    // Task should be marked as Completed
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
  })

  it('uses explicit action value from output_fields if present', async () => {
    const mockDb = createEnterpriseTaskDb({
      output_fields: [{ id: 'action', name: 'Action', type: 'text', value: 'approve' }],
    })
    const { mgr, session } = setupManager(mockDb)

    const mockSyncManager = {
      executeAction: vi.fn().mockResolvedValue({ success: true }),
    }
    mgr.setSyncManager(mockSyncManager as any)

    await (mgr as any).transitionToIdle('session-1', session)

    expect(mockSyncManager.executeAction).toHaveBeenCalledWith(
      'approve',
      expect.anything(),
      undefined,
      'source-1'
    )
  })

  it('reverts to ReadyForReview when executeAction fails', async () => {
    const mockDb = createEnterpriseTaskDb()
    const { mgr, session } = setupManager(mockDb)

    const mockSyncManager = {
      executeAction: vi.fn().mockResolvedValue({ success: false, error: 'API unavailable' }),
    }
    mgr.setSyncManager(mockSyncManager as any)

    const sendSpy = vi.spyOn(mgr as any, 'sendToRenderer')

    await (mgr as any).transitionToIdle('session-1', session)

    // Task should be reverted to ReadyForReview
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.ReadyForReview })

    // Renderer should be notified with ReadyForReview
    const taskUpdatedCall = sendSpy.mock.calls.find(
      (call) => call[0] === 'task:updated' && (call[1] as any)?.updates?.status === TaskStatus.ReadyForReview
    )
    expect(taskUpdatedCall).toBeDefined()

    // Task should NOT be marked as Completed
    const completedCall = (mockDb.updateTask as any).mock.calls.find(
      (call: any[]) => call[1]?.status === TaskStatus.Completed
    )
    expect(completedCall).toBeUndefined()
  })

  it('reverts to ReadyForReview when executeAction throws', async () => {
    const mockDb = createEnterpriseTaskDb()
    const { mgr, session } = setupManager(mockDb)

    const mockSyncManager = {
      executeAction: vi.fn().mockRejectedValue(new Error('Network error')),
    }
    mgr.setSyncManager(mockSyncManager as any)

    await (mgr as any).transitionToIdle('session-1', session)

    // Task should be reverted to ReadyForReview
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.ReadyForReview })
  })

  it('skips executeAction for non-enterprise tasks (no source_id)', async () => {
    const mockDb = createEnterpriseTaskDb({ source_id: null })
    const { mgr, session } = setupManager(mockDb)

    const mockSyncManager = {
      executeAction: vi.fn().mockResolvedValue({ success: true }),
    }
    mgr.setSyncManager(mockSyncManager as any)

    await (mgr as any).transitionToIdle('session-1', session)

    // executeAction should NOT be called
    expect(mockSyncManager.executeAction).not.toHaveBeenCalled()

    // Task should still be marked as Completed
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
  })

  it('skips executeAction when syncManager is not set', async () => {
    const mockDb = createEnterpriseTaskDb()
    const { mgr, session } = setupManager(mockDb)

    // Do NOT set syncManager

    await (mgr as any).transitionToIdle('session-1', session)

    // Task should still be marked as Completed (graceful degradation)
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
  })

  it('replays missed transcript parts before transitioning idle', async () => {
    const mockDb = createEnterpriseTaskDb({
      status: TaskStatus.AgentWorking,
      output_fields: [],
      source_id: null,
    })
    const { mgr, session } = setupManager(mockDb)
    const adapter = {
      getAllMessages: vi.fn(async () => ([
        {
          id: 'msg-1',
          role: MessageRole.ASSISTANT,
          parts: [
            { id: 'seen-part', type: MessagePartType.TEXT, text: 'Earlier reply', content: 'Earlier reply' },
            { id: 'final-part', type: MessagePartType.TEXT, text: 'Final persisted reply', content: 'Final persisted reply' }
          ]
        }
      ]))
    }

    const sessionWithAdapter = {
      ...session,
      adapter: adapter as any
    }
    sessionWithAdapter.seenPartIds.add('seen-part')
    vi.spyOn(mgr as any, 'extractOutputValues').mockResolvedValue(undefined)

    const sendSpy = vi.spyOn(mgr as any, 'sendToRenderer')

    await (mgr as any).transitionToIdle('session-1', sessionWithAdapter)

    const replayCall = sendSpy.mock.calls.find(
      ([channel, payload]) => channel === 'agent:output-batch'
        && (payload as any)?.messages?.some((msg: any) => msg.id === 'final-part' && msg.content === 'Final persisted reply')
    )

    expect(adapter.getAllMessages).toHaveBeenCalledOnce()
    expect(replayCall).toBeDefined()
    expect(sessionWithAdapter.seenPartIds.has('final-part')).toBe(true)
  })

  it('resumeAdapterSession uses same IDs for batch replay and dedup state (regression: dual-loop bug)', async () => {
    // This test ensures the batch replay IDs and dedup state IDs are identical.
    // Previously, two separate loops each called Date.now() + Math.random() for
    // parts without an id, producing different IDs — causing message duplication
    // on follow-up messages.
    const mockDb = createMockDb({})
    const mgr = new AgentManager(mockDb)
    const sendSpy = vi.spyOn(mgr as any, 'sendToRenderer')

    const adapter = {
      initialize: vi.fn(async () => {}),
      resumeSession: vi.fn(async () => [
        {
          id: 'msg-1',
          role: MessageRole.ASSISTANT,
          parts: [
            // Part WITHOUT an id — triggers random ID generation
            { type: MessagePartType.TEXT, text: 'Hello world', content: 'Hello world' },
          ]
        },
        {
          id: 'msg-2',
          role: MessageRole.ASSISTANT,
          parts: [
            // Part WITH an id — uses stable id
            { id: 'stable-part-id', type: MessagePartType.TEXT, text: 'Stable', content: 'Stable' },
          ]
        }
      ]),
    }

    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(mgr as any, 'db', 'get').mockReturnValue({
      ...mockDb,
      getWorkspaceDir: vi.fn(() => '/tmp/ws'),
    })

    await (mgr as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'session-1', {
      replayToRenderer: true
    })

    // Get the batch messages sent to renderer
    const batchCall = sendSpy.mock.calls.find(
      ([channel]) => channel === 'agent:output-batch'
    )
    expect(batchCall).toBeDefined()
    const batchMessages = (batchCall![1] as any).messages as Array<{ id: string }>

    // Get the session's dedup state
    const session = (mgr as any).sessions.get('session-1')
    expect(session).toBeDefined()

    // CRITICAL: Every batch message ID must be in the dedup state
    for (const msg of batchMessages) {
      expect(session.seenPartIds.has(msg.id)).toBe(true)
    }

    // Stable part should use its own id
    expect(batchMessages.find((m: { id: string }) => m.id === 'stable-part-id')).toBeDefined()
    expect(session.seenPartIds.has('stable-part-id')).toBe(true)

    // Message-level IDs should also be tracked for codex-style message dedup
    expect(session.seenMessageIds.has('msg-1')).toBe(true)
    expect(session.seenMessageIds.has('msg-2')).toBe(true)
  })
})

describe('AgentManager shutdown', () => {
  it('stopAllSessions waits for all stopSession promises', async () => {
    const mockDb = createMockDb({})
    const mgr = new AgentManager(mockDb)

    ;(mgr as any).sessions.set('s1', { taskId: 'task-1' })
    ;(mgr as any).sessions.set('s2', { taskId: 'task-2' })

    let pendingStops = 0
    vi.spyOn(mgr, 'stopSession').mockImplementation(async () => {
      pendingStops += 1
      await new Promise(resolve => setTimeout(resolve, 0))
      pendingStops -= 1
    })

    await mgr.stopAllSessions()

    expect(mgr.stopSession).toHaveBeenCalledTimes(2)
    expect(mgr.stopSession).toHaveBeenCalledWith('s1', false)
    expect(mgr.stopSession).toHaveBeenCalledWith('s2', false)
    expect(pendingStops).toBe(0)
  })
})

describe('AgentManager session ID re-keying redirect', () => {
  function createManagerWithSession() {
    const mockDb = {
      getTask: vi.fn(() => ({ id: 'task-1', title: 'Test', agent_id: 'agent-1' })),
      getAgent: vi.fn(() => ({ id: 'agent-1', name: 'Agent', config: {} })),
      getWorkspaceDir: vi.fn(() => '/tmp/ws'),
      updateTask: vi.fn(),
      getMcpServer: vi.fn(() => null),
      getSecretsByIds: vi.fn(() => []),
      getSecretsWithValues: vi.fn(() => []),
      getSetting: vi.fn(() => null),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)

    // Create session with temp ID
    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      adapter: {
        respondToQuestion: vi.fn(async () => undefined),
        getStatus: vi.fn(async () => ({ type: 'working' })),
        sendPrompt: vi.fn(async () => undefined),
        abortPrompt: vi.fn(async () => undefined),
      },
      pollingStarted: true,
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
    }
    ;(mgr as any).sessions.set('temp-id', session)

    return { mgr, session }
  }

  it('respondToPermission resolves re-keyed session via redirect map', async () => {
    const { mgr, session } = createManagerWithSession()

    // Simulate re-keying: move session from temp-id to real-id
    ;(mgr as any).sessions.delete('temp-id')
    ;(mgr as any).sessions.set('real-id', session)
    ;(mgr as any).sessionIdRedirects.set('temp-id', 'real-id')

    // This would throw "Session not found: temp-id" before the fix
    await expect(mgr.respondToPermission('temp-id', true, 'Yes')).resolves.not.toThrow()
  })

  it('respondToPermission still throws for truly unknown session IDs', async () => {
    const { mgr } = createManagerWithSession()

    await expect(mgr.respondToPermission('unknown-id', true)).rejects.toThrow('Session not found: unknown-id')
  })

  it('abortSession resolves re-keyed session via redirect map', async () => {
    const { mgr, session } = createManagerWithSession()

    // Simulate re-keying
    ;(mgr as any).sessions.delete('temp-id')
    ;(mgr as any).sessions.set('real-id', session)
    ;(mgr as any).sessionIdRedirects.set('temp-id', 'real-id')

    vi.spyOn(mgr as any, 'stopAdapterPolling').mockImplementation(() => undefined)
    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue(session.adapter)
    vi.spyOn(mgr as any, 'buildSessionConfig').mockResolvedValue({})

    // Should not silently return — should actually abort the re-keyed session
    await mgr.abortSession('temp-id')
    expect(session.status).toBe('idle')
  })

  it('sendMessage resolves re-keyed session via redirect map', async () => {
    const { mgr, session } = createManagerWithSession()

    // Simulate re-keying
    ;(mgr as any).sessions.delete('temp-id')
    ;(mgr as any).sessions.set('real-id', session)
    ;(mgr as any).sessionIdRedirects.set('temp-id', 'real-id')

    const doSendSpy = vi.spyOn(mgr as any, 'doSendAdapterMessage').mockResolvedValue(undefined)

    const result = await mgr.sendMessage('temp-id', 'hello')
    expect(doSendSpy).toHaveBeenCalledOnce()
    // Should not return a newSessionId since session was found via redirect
    expect(result.newSessionId).toBeUndefined()
  })

  it('stopSession cleans up redirect entries pointing to destroyed session', async () => {
    const { mgr, session } = createManagerWithSession()

    // Set up redirect and session under real-id
    ;(mgr as any).sessions.delete('temp-id')
    ;(mgr as any).sessions.set('real-id', session)
    ;(mgr as any).sessionIdRedirects.set('temp-id', 'real-id')

    vi.spyOn(mgr as any, 'stopAdapterPolling').mockImplementation(() => undefined)
    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue(null)

    await mgr.stopSession('real-id')

    // Redirect should be cleaned up
    expect((mgr as any).sessionIdRedirects.has('temp-id')).toBe(false)
    expect((mgr as any).sessions.has('real-id')).toBe(false)
  })
})

describe('AgentManager resumeAdapterSession — SESSION_ENDED for completed tasks', () => {
  it('returns empty string instead of throwing for ReadyForReview tasks', async () => {
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Test',
        agent_id: 'agent-1',
        status: TaskStatus.ReadyForReview,
      })),
      getAgent: vi.fn(() => ({
        id: 'agent-1',
        name: 'Agent',
        config: { coding_agent: 'claude-code' },
      })),
      getWorkspaceDir: vi.fn(() => '/tmp/ws'),
      updateTask: vi.fn(),
      getMcpServer: vi.fn(() => null),
      getSecretsByIds: vi.fn(() => []),
      getSecretsWithValues: vi.fn(() => []),
      getSetting: vi.fn(() => null),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)

    const adapter = {
      initialize: vi.fn(async () => undefined),
      resumeSession: vi.fn(async () => {
        throw new Error('INCOMPATIBLE_SESSION_ID: session expired')
      }),
    }

    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(mgr as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(mgr as any, 'setupSecretSession').mockReturnValue(null)
    vi.spyOn(mgr as any, 'buildSecretsSystemPrompt').mockReturnValue('')

    // Should NOT throw — returns empty string to signal session ended
    const result = await mgr.resumeSession('agent-1', 'task-1', 'old-session-id')
    expect(result).toBe('')

    // session_id should be cleared
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { session_id: null })
  })

  it('still throws for non-completed tasks with incompatible session', async () => {
    const mockDb = {
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Test',
        agent_id: 'agent-1',
        status: TaskStatus.AgentWorking,
      })),
      getAgent: vi.fn(() => ({
        id: 'agent-1',
        name: 'Agent',
        config: { coding_agent: 'claude-code' },
      })),
      getWorkspaceDir: vi.fn(() => '/tmp/ws'),
      updateTask: vi.fn(),
      getMcpServer: vi.fn(() => null),
      getSecretsByIds: vi.fn(() => []),
      getSecretsWithValues: vi.fn(() => []),
      getSetting: vi.fn(() => null),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)

    const adapter = {
      initialize: vi.fn(async () => undefined),
      resumeSession: vi.fn(async () => {
        throw new Error('INCOMPATIBLE_SESSION_ID: session expired')
      }),
    }

    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue(adapter)
    vi.spyOn(mgr as any, 'buildMcpServersForAdapter').mockResolvedValue({})
    vi.spyOn(mgr as any, 'setupSecretSession').mockReturnValue(null)
    vi.spyOn(mgr as any, 'buildSecretsSystemPrompt').mockReturnValue('')

    // Should still throw for non-completed tasks
    await expect(mgr.resumeSession('agent-1', 'task-1', 'old-session-id')).rejects.toThrow()
  })
})

describe('syncAttachmentsToWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('copies task attachments from DB storage to workspace/attachments/', () => {
    const mockDb = {
      ...createMockDb(),
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Test Task',
        attachments: [
          { id: 'att-1', filename: 'design.png', size: 1024, mime_type: 'image/png', added_at: '2026-04-01' },
          { id: 'att-2', filename: 'spec.pdf', size: 2048, mime_type: 'application/pdf', added_at: '2026-04-02' },
        ],
      })),
      getAttachmentsDir: vi.fn(() => '/data/attachments/task-1'),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const mgr = new AgentManager(mockDb)

    // All source files exist
    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p)
      if (path.includes('att-1-design.png') || path.includes('att-2-spec.pdf')) return true
      // destDir doesn't exist yet
      if (path.endsWith('/attachments')) return false
      return false
    })

    const refs = (mgr as any).syncAttachmentsToWorkspace('task-1', '/tmp/ws')

    // Should create the destination directory
    expect(mockedMkdirSync).toHaveBeenCalledWith('/tmp/ws/attachments', { recursive: true })

    // Should copy both files
    expect(mockedCopyFileSync).toHaveBeenCalledWith(
      '/data/attachments/task-1/att-1-design.png',
      '/tmp/ws/attachments/design.png'
    )
    expect(mockedCopyFileSync).toHaveBeenCalledWith(
      '/data/attachments/task-1/att-2-spec.pdf',
      '/tmp/ws/attachments/spec.pdf'
    )

    // Should return references
    expect(refs).toEqual([
      '- attachments/design.png',
      '- attachments/spec.pdf',
    ])
  })

  it('returns empty array when task has no attachments', () => {
    const mockDb = {
      ...createMockDb(),
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Test Task',
        attachments: [],
      })),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const mgr = new AgentManager(mockDb)

    const refs = (mgr as any).syncAttachmentsToWorkspace('task-1', '/tmp/ws')
    expect(refs).toEqual([])
    expect(mockedCopyFileSync).not.toHaveBeenCalled()
  })

  it('skips missing source files gracefully', () => {
    const mockDb = {
      ...createMockDb(),
      getTask: vi.fn(() => ({
        id: 'task-1',
        title: 'Test Task',
        attachments: [
          { id: 'att-1', filename: 'exists.txt', size: 100, mime_type: 'text/plain', added_at: '2026-04-01' },
          { id: 'att-2', filename: 'missing.txt', size: 200, mime_type: 'text/plain', added_at: '2026-04-02' },
        ],
      })),
      getAttachmentsDir: vi.fn(() => '/data/attachments/task-1'),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const mgr = new AgentManager(mockDb)

    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p)
      if (path.includes('att-1-exists.txt')) return true
      if (path.includes('att-2-missing.txt')) return false
      if (path.endsWith('/attachments')) return true // destDir already exists
      return false
    })

    const refs = (mgr as any).syncAttachmentsToWorkspace('task-1', '/tmp/ws')

    // Only the existing file should be copied
    expect(mockedCopyFileSync).toHaveBeenCalledTimes(1)
    expect(mockedCopyFileSync).toHaveBeenCalledWith(
      '/data/attachments/task-1/att-1-exists.txt',
      '/tmp/ws/attachments/exists.txt'
    )
    expect(refs).toEqual(['- attachments/exists.txt'])
  })
})

describe('AgentManager startAdapterPolling — IDLE grace period for follow-up messages', () => {
  // Regression test for: "opencode transitions to idle without any response".
  // When a follow-up message is sent, startAdapterPolling is invoked with an
  // existingSession so that dedup state (seenMessageIds / seenPartIds) is
  // preserved. Previously `hasSeenWork` was pre-set to true whenever an
  // existingSession was passed, which caused the IDLE grace period to be
  // skipped. Because opencode's sendPrompt is fire-and-forget, the first poll
  // after a follow-up can briefly observe IDLE while the server is still
  // ingesting the request. Skipping the grace period meant transitionToIdle
  // ran immediately and the session flipped to idle without any response.

  function buildManager() {
    const mockDb = createMockDb({})
    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    vi.spyOn(mgr as any, 'ensurePollingCoordinator').mockImplementation(() => undefined)
    return mgr
  }

  function buildAdapter() {
    return {
      pollMessages: vi.fn(async () => [] as any[]),
      getStatus: vi.fn(async () => ({ type: 'idle' as string })),
    }
  }

  it('creates a PollingEntry with hasSeenWork=false when existingSession is provided', () => {
    const mgr = buildManager()
    const adapter = buildAdapter()

    const existingSession = {
      seenMessageIds: new Set(['msg-1']),
      seenPartIds: new Set(['part-1']),
      partContentLengths: new Map([['part-1', '10']]),
    } as any

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      existingSession
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    expect(entry).toBeDefined()
    // hasSeenWork MUST start false so the IDLE grace period applies to every
    // new prompt — not just brand-new sessions.
    expect(entry.hasSeenWork).toBe(false)
    // Dedup state from the existing session should still be preserved so
    // historical messages aren't re-sent to the renderer.
    expect(entry.seenMessageIds.has('msg-1')).toBe(true)
    expect(entry.seenPartIds.has('part-1')).toBe(true)
    expect(entry.partContentLengths.get('part-1')).toBe('10')
  })

  it('pollSingleSession skips transitionToIdle during grace period on follow-up (regression: premature idle)', async () => {
    const mgr = buildManager()
    const adapter = buildAdapter()

    // Simulate a real session in memory
    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(['msg-1']),
      seenPartIds: new Set<string>(['part-1']),
      partContentLengths: new Map<string, string>(),
      adapter,
    }
    ;(mgr as any).sessions.set('session-1', session)

    // Start polling as if a follow-up message was just sent. Pre-fix this
    // would set hasSeenWork=true and skip the grace period.
    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    expect(entry).toBeDefined()
    // Keep it fresh so sessionAge stays under the 15s grace window
    entry.createdAt = Date.now()

    // Fail loudly if the regression returns and transitionToIdle fires before
    // any work has been observed.
    const transitionSpy = vi.spyOn(mgr as any, 'transitionToIdle').mockResolvedValue(undefined)

    // Run one poll cycle — adapter reports IDLE (prompt not yet ingested)
    await (mgr as any).pollSingleSession(entry)

    expect(transitionSpy).not.toHaveBeenCalled()
    // Entry must still be registered so subsequent polls can observe BUSY
    // once the backend actually picks up the prompt.
    expect((mgr as any).pollingEntries.has('session-1')).toBe(true)
  })

  it('pollSingleSession does NOT set hasSeenWork from message content — only from BUSY status (root cause: stale parts)', async () => {
    // ROOT CAUSE regression test: pollMessages can return stale assistant tool
    // parts (fingerprint updates from the previous turn) or user echoes.  The
    // old code set hasSeenWork=true on any non-user part, which disabled the
    // grace period.  On the same poll cycle getStatus returned IDLE (backend
    // still ingesting the prompt), so transitionToIdle fired with no response.
    //
    // Fix: hasSeenWork is set ONLY when getStatus returns BUSY/WAITING_APPROVAL.
    const mgr = buildManager()
    const adapter = buildAdapter()

    // pollMessages returns stale assistant parts (fingerprint update from
    // a previous tool call) — NOT new work from the current prompt
    adapter.pollMessages.mockResolvedValueOnce([
      { id: 'tool-1', role: 'assistant', content: 'done', type: 'tool', update: true }
    ])
    // Backend still reports IDLE while ingesting the prompt
    adapter.getStatus.mockResolvedValueOnce({ type: 'idle' as const })

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.createdAt = Date.now()

    const transitionSpy = vi.spyOn(mgr as any, 'transitionToIdle').mockResolvedValue(undefined)

    await (mgr as any).pollSingleSession(entry)

    // hasSeenWork must stay false — message content never sets it
    expect(entry.hasSeenWork).toBe(false)
    // Grace period should prevent transition
    expect(transitionSpy).not.toHaveBeenCalled()
    expect((mgr as any).pollingEntries.has('session-1')).toBe(true)
  })

  it('pollSingleSession sets hasSeenWork=true when getStatus returns BUSY', async () => {
    const mgr = buildManager()
    const adapter = buildAdapter()

    adapter.pollMessages.mockResolvedValueOnce([])
    adapter.getStatus.mockResolvedValueOnce({ type: 'busy' as const })

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.createdAt = Date.now()

    await (mgr as any).pollSingleSession(entry)

    // BUSY status is the authoritative signal → hasSeenWork must be true
    expect(entry.hasSeenWork).toBe(true)
  })

  it('pollSingleSession transitions to idle after BUSY then IDLE (work completed)', async () => {
    const mgr = buildManager()
    const adapter = buildAdapter()

    // First poll: BUSY
    adapter.pollMessages.mockResolvedValueOnce([
      { id: 'resp-1', role: 'assistant', content: 'Working...', type: 'text' }
    ])
    adapter.getStatus.mockResolvedValueOnce({ type: 'busy' as const })

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      lastAssistantText: '',
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.createdAt = Date.now()

    const transitionSpy = vi.spyOn(mgr as any, 'transitionToIdle').mockResolvedValue(undefined)

    // First poll: BUSY → hasSeenWork=true, no transition
    await (mgr as any).pollSingleSession(entry)
    expect(entry.hasSeenWork).toBe(true)
    expect(transitionSpy).not.toHaveBeenCalled()

    // Second poll: IDLE after real work → transition
    adapter.pollMessages.mockResolvedValueOnce([])
    adapter.getStatus.mockResolvedValueOnce({ type: 'idle' as const })
    await (mgr as any).pollSingleSession(entry)
    expect(transitionSpy).toHaveBeenCalledOnce()
  })

  it('pollSingleSession transitions to idle after grace period expires without work (new session stuck)', async () => {
    const mgr = buildManager()
    const adapter = buildAdapter()

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }
    )

    // Backdate the entry so the 15s grace period has elapsed.
    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.createdAt = Date.now() - 30_000

    const transitionSpy = vi.spyOn(mgr as any, 'transitionToIdle').mockResolvedValue(undefined)

    await (mgr as any).pollSingleSession(entry)

    expect(transitionSpy).toHaveBeenCalledOnce()
  })
})
