/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentManager } from './agent-manager'
import { SessionStatus, TaskStatus } from '../shared/constants'
import { MessagePartType, MessageRole, SessionStatusType } from './adapters/coding-agent-adapter'
import { unregisterSecretSession } from './secret-broker'

// Mock filesystem operations
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
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
    powerSaveBlocker: {
      start: vi.fn(() => 1),
      stop: vi.fn(),
      isStarted: vi.fn(() => false),
    },
  }
})
vi.mock('./adapters/opencode-adapter', () => ({ OpencodeAdapter: vi.fn() }))
vi.mock('./adapters/claude-code-adapter', () => ({ ClaudeCodeAdapter: vi.fn() }))
vi.mock('./adapters/acp-adapter', () => ({ AcpAdapter: vi.fn() }))
vi.mock('./adapters/codex-app-server-adapter', () => ({ CodexAppServerAdapter: vi.fn() }))
vi.mock('./task-api-server', () => ({ getTaskApiPort: vi.fn(), waitForTaskApiServer: vi.fn() }))
vi.mock('./secret-broker', () => ({
  registerSecretSession: vi.fn(),
  unregisterSecretSession: vi.fn(),
  getSecretBrokerPort: vi.fn(),
  writeSecretShellWrapper: vi.fn(),
}))

import { mkdir as mkdirAsync, writeFile as writeFileAsync } from 'fs/promises'
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'fs'
import { AcpAdapter } from './adapters/acp-adapter'
import { CodexAppServerAdapter } from './adapters/codex-app-server-adapter'

const mockedMkdirAsync = vi.mocked(mkdirAsync)
const mockedWriteFileAsync = vi.mocked(writeFileAsync)
const mockedExistsSync = vi.mocked(existsSync)
const mockedCopyFileSync = vi.mocked(copyFileSync)
const mockedMkdirSync = vi.mocked(mkdirSync)
const mockedReadFileSync = vi.mocked(readFileSync)

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
    getTasks: vi.fn(() => []),
    getSubtasks: vi.fn(() => []),
    getAgent: vi.fn(() => ({
      id: 'agent-1',
      name: 'Test Agent',
      config: agentConfig,
    })),
    getAgents: vi.fn(() => ([{
      id: 'agent-1',
      name: 'Test Agent',
      is_default: true,
      config: agentConfig,
    }])),
    getSkills: vi.fn(() => [makeSkillRecord()]),
    getSkillsByIds: vi.fn(() => [makeSkillRecord()]),
    getSkillByName: vi.fn(() => null),
    getMcpServer: vi.fn(() => null),
    getSecretsByIds: vi.fn(() => []),
    getSetting: vi.fn(() => null),
    getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
    updateTask: vi.fn(),
  } as unknown as ConstructorParameters<typeof AgentManager>[0]
}

let manager: AgentManager

describe('AgentManager skill file paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CODEX_APP_SERVER
  })

  describe('getAdapter', () => {
    it('uses Codex app-server by default for Codex agents', () => {
      const mockDb = createMockDb({ coding_agent: 'codex' })
      manager = new AgentManager(mockDb)

      const adapter = (manager as any).getAdapter('agent-1')

      expect(adapter).toBeInstanceOf(CodexAppServerAdapter)
      expect(CodexAppServerAdapter).toHaveBeenCalledOnce()
      expect(AcpAdapter).not.toHaveBeenCalled()
    })

    it('keeps an explicit ACP fallback for Codex agents', () => {
      process.env.CODEX_APP_SERVER = '0'
      const mockDb = createMockDb({ coding_agent: 'codex' })
      manager = new AgentManager(mockDb)

      const adapter = (manager as any).getAdapter('agent-1')

      expect(adapter).toBeInstanceOf(AcpAdapter)
      expect(AcpAdapter).toHaveBeenCalledWith('codex')
      expect(CodexAppServerAdapter).not.toHaveBeenCalled()
    })

    it('uses ACP for Cursor agents', () => {
      const mockDb = createMockDb({ coding_agent: 'cursor' })
      manager = new AgentManager(mockDb)

      const adapter = (manager as any).getAdapter('agent-1')

      expect(adapter).toBeInstanceOf(AcpAdapter)
      expect(AcpAdapter).toHaveBeenCalledWith('cursor')
    })
  })

  describe('shouldEnableTillDone', () => {
    it('disables tillDone for Mastermind sessions', () => {
      const mockDb = createMockDb({ coding_agent: 'opencode' })
      manager = new AgentManager(mockDb)

      expect((manager as any).shouldEnableTillDone('mastermind-session', null)).toBe(false)
    })

    it('disables tillDone for non-work orchestration sessions', () => {
      const mockDb = createMockDb({ coding_agent: 'opencode' })
      manager = new AgentManager(mockDb)

      expect((manager as any).shouldEnableTillDone('heartbeat-task-1', null)).toBe(false)
      expect((manager as any).shouldEnableTillDone('task-1', { status: TaskStatus.Triaging })).toBe(false)
      expect((manager as any).shouldEnableTillDone('task-1', { status: TaskStatus.NotStarted, agent_id: null })).toBe(false)
      expect((manager as any).shouldEnableTillDone('task-1', { status: TaskStatus.AgentLearning })).toBe(false)
    })

    it('enables tillDone for regular task sessions', () => {
      const mockDb = createMockDb({ coding_agent: 'opencode' })
      manager = new AgentManager(mockDb)

      expect((manager as any).shouldEnableTillDone('task-1', { status: TaskStatus.NotStarted, agent_id: 'agent-1' })).toBe(true)
    })
  })

  describe('writeSkillFiles', () => {
    it('writes and documents only the skills selected for the task', async () => {
      const selectedSkill = makeSkillRecord({ id: 'selected', name: 'selected-skill' })
      const unselectedSkill = makeSkillRecord({ id: 'unselected', name: 'unselected-skill' })
      const mockDb = {
        ...createMockDb({ coding_agent: 'codex', skill_ids: ['selected'] }),
        getTask: vi.fn(() => ({
          id: 'task-1',
          title: 'Test Task',
          repos: ['org/repo'],
          skill_ids: ['selected'],
        })),
        getSkills: vi.fn(() => [selectedSkill, unselectedSkill]),
        getSkillsByIds: vi.fn(() => [selectedSkill]),
      } as unknown as ConstructorParameters<typeof AgentManager>[0]
      manager = new AgentManager(mockDb)

      await (manager as any).writeSkillFiles('task-1', 'agent-1', '/tmp/test-workspace')

      const writes = mockedWriteFileAsync.mock.calls
      const writeFilePaths = writes.map(c => c[0] as string)
      expect(writeFilePaths).toContain('/tmp/test-workspace/.agents/skills/selected-skill/SKILL.md')
      expect(writeFilePaths).not.toContain('/tmp/test-workspace/.agents/skills/unselected-skill/SKILL.md')
      expect((mockDb as any).getSkillsByIds).toHaveBeenCalledWith(['selected'])
      expect((mockDb as any).getSkills).not.toHaveBeenCalled()

      const agentsMd = writes.find(c => c[0] === '/tmp/test-workspace/AGENTS.md')?.[1] as string
      const claudeMd = writes.find(c => c[0] === '/tmp/test-workspace/CLAUDE.md')?.[1] as string
      expect(agentsMd).toContain('selected-skill')
      expect(agentsMd).not.toContain('unselected-skill')
      expect(claudeMd).toContain('selected-skill')
      expect(claudeMd).not.toContain('unselected-skill')
    })

    it('does not write or document any skills when none are selected', async () => {
      const mockDb = {
        ...createMockDb({ coding_agent: 'codex' }),
        getTask: vi.fn(() => ({
          id: 'task-1',
          title: 'Test Task',
          repos: ['org/repo'],
          skill_ids: null,
        })),
        getSkills: vi.fn(() => [makeSkillRecord()]),
        getSkillsByIds: vi.fn(() => [makeSkillRecord()]),
      } as unknown as ConstructorParameters<typeof AgentManager>[0]
      manager = new AgentManager(mockDb)

      await (manager as any).writeSkillFiles('task-1', 'agent-1', '/tmp/test-workspace')

      const writes = mockedWriteFileAsync.mock.calls
      expect(writes.some(c => (c[0] as string).endsWith('/SKILL.md'))).toBe(false)
      expect((mockDb as any).getSkills).not.toHaveBeenCalled()
      expect((mockDb as any).getSkillsByIds).not.toHaveBeenCalled()

      const agentsMd = writes.find(c => c[0] === '/tmp/test-workspace/AGENTS.md')?.[1] as string
      const claudeMd = writes.find(c => c[0] === '/tmp/test-workspace/CLAUDE.md')?.[1] as string
      expect(agentsMd).toContain('No skills configured for this session.')
      expect(claudeMd).toContain('No skills are available for this session.')
    })

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

    it('wraps YAML frontmatter values in double quotes to handle special characters', async () => {
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
      // Values are wrapped in double quotes so special chars (brackets, colons, hashes)
      // are treated as literal YAML string content instead of breaking the parser.
      expect(writtenContent).toContain('name: "[Workflo] gh-pr-base-branch-check"')
      expect(writtenContent).toContain('description: "Check base branch {details}: see #docs"')
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

  it('does NOT push a transcript replay to the renderer when sendMessage implicitly resumes a session', async () => {
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

    // Resume no longer replays the transcript to clients. Clients render the
    // durable projection (snapshot + `transcript:changed` deltas), so a resume
    // must not re-emit historical messages as a stream (which caused reorder /
    // duplication on send-after-idle).
    const outputBatchEvents = sendToRendererSpy.mock.calls.filter(([channel]) => channel === 'agent:output-batch')
    expect(outputBatchEvents).toHaveLength(0)
  })

  it('does NOT push a transcript replay during explicit resume', async () => {
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

    // Resume seeds only the in-memory dedup state; it never streams historical
    // messages to clients. The projection (snapshot + deltas) is the render source.
    const outputBatchEvents = sendToRendererSpy.mock.calls.filter(([channel]) => channel === 'agent:output-batch')
    expect(outputBatchEvents).toHaveLength(0)
  })
})

describe('AgentManager MCP server routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pins artifact MCP tools to the current task without restricting task orchestration', async () => {
    const mockDb = {
      getAgent: vi.fn(() => ({ id: 'agent-1', name: 'Agent', config: { mcp_servers: ['task-management-id'] } })),
      getMcpServer: vi.fn(() => ({
        id: 'task-management-id',
        name: 'task-management',
        type: 'local',
        command: 'node',
        args: ['task-management-mcp.js'],
        environment: {}
      }))
    } as unknown as ConstructorParameters<typeof AgentManager>[0]
    const manager = new AgentManager(mockDb)

    const mcpServers = await (manager as any).buildMcpServersForAdapter('agent-1', {
      artifactTaskId: 'task-current'
    })

    expect(mcpServers['task-management'].env).toEqual(expect.objectContaining({
      TASK_ARTIFACT_SCOPE_ID: 'task-current'
    }))
    expect(mcpServers['task-management'].env).not.toHaveProperty('TASK_SCOPE_TASK_ID')
  })

  it('canonicalizes Workflo MCP dev server URLs to the active enterprise API URL for enterprise-sourced servers', async () => {
    const mockDb = {
      getAgent: vi.fn(() => ({
        id: 'agent-1',
        name: 'OPS L2',
        config: {
          mcp_servers: ['workflo-stage-server']
        }
      })),
      getMcpServer: vi.fn(() => ({
        id: 'workflo-stage-server',
        name: '[Workflo] MCP Dev Server',
        type: 'remote',
        url: 'https://stage-api.peakflo.ai/api/mcp/dev/mcp',
        headers: {},
        oauth_metadata: {},
        source: 'enterprise',
      })),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    manager.setEnterpriseAuth({
      getApiUrl: vi.fn(() => 'https://api.peakflo.ai'),
      getJwt: vi.fn(async () => 'fresh-prod-jwt'),
    } as any)

    const mcpServers = await (manager as any).buildMcpServersForAdapter('agent-1')

    expect(mcpServers['[Workflo] MCP Dev Server']).toMatchObject({
      type: 'http',
      url: 'https://api.peakflo.ai/api/mcp/dev/mcp',
      headers: { Authorization: 'Bearer fresh-prod-jwt' },
    })
  })

  it('does NOT auto-manage a user-sourced MCP, even when name and URL look like the enterprise one (provenance check)', async () => {
    // Regression — the primary tenant-leak fix.
    // A user-added MCP whose `source` is 'user' must never be hijacked, no
    // matter what its name or URL looks like. Before Phase 1 this was a
    // name/path heuristic and any "*workflo*" name + /api/mcp/dev/mcp path
    // got auto-managed → tenant leak. Now identification is provenance-only.
    const mockDb = {
      getAgent: vi.fn(() => ({
        id: 'agent-1',
        name: 'OPS L2',
        config: {
          mcp_servers: ['tan-insurance-workflo'],
        },
      })),
      getMcpServer: vi.fn(() => ({
        id: 'tan-insurance-workflo',
        name: '[Workflo] MCP Dev Server',  // user copied the canonical name
        type: 'remote',
        url: 'https://stage-api.peakflo.ai/api/mcp/dev/mcp',  // and the canonical URL
        headers: {},
        oauth_metadata: {},
        source: 'user',  // but it was added by the user, not by enterprise sync
      })),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    manager.setEnterpriseAuth({
      getApiUrl: vi.fn(() => 'https://api.peakflo.ai'),
      getJwt: vi.fn(async () => 'fresh-prod-jwt-for-tenant-b'),
    } as any)

    const mcpServers = await (manager as any).buildMcpServersForAdapter('agent-1')

    expect(mcpServers['[Workflo] MCP Dev Server']).toMatchObject({
      type: 'http',
      // URL is NOT rewritten — user pointed at stage, request goes to stage
      url: 'https://stage-api.peakflo.ai/api/mcp/dev/mcp',
    })
    // No Authorization injected — user didn't set one and the proxy is not invoked
    expect(mcpServers['[Workflo] MCP Dev Server'].headers).not.toHaveProperty('Authorization')
  })

  it('respects a user-supplied Authorization header even when an enterprise-sourced row carries one (defence-in-depth)', async () => {
    // Defence-in-depth: even if a row is somehow mislabelled as 'enterprise'
    // but the user/sync wrote an Authorization header, honour their explicit
    // credential and skip the auto-manage path.
    const mockDb = {
      getAgent: vi.fn(() => ({
        id: 'agent-1',
        name: 'OPS L2',
        config: {
          mcp_servers: ['tan-insurance-workflo'],
        },
      })),
      getMcpServer: vi.fn(() => ({
        id: 'tan-insurance-workflo',
        name: 'Tan Insurance MCP workflo',
        type: 'remote',
        url: 'https://stage-api.peakflo.ai/api/mcp/dev/mcp',
        headers: { Authorization: 'Bearer pfwf_tenant_a_key' },
        oauth_metadata: {},
        source: 'enterprise',
      })),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]

    const manager = new AgentManager(mockDb)
    manager.setEnterpriseAuth({
      getApiUrl: vi.fn(() => 'https://api.peakflo.ai'),
      getJwt: vi.fn(async () => 'fresh-prod-jwt-for-tenant-b'),
    } as any)

    const mcpServers = await (manager as any).buildMcpServersForAdapter('agent-1')

    expect(mcpServers['Tan Insurance MCP workflo']).toMatchObject({
      type: 'http',
      url: 'https://stage-api.peakflo.ai/api/mcp/dev/mcp',
      headers: { Authorization: 'Bearer pfwf_tenant_a_key' },
    })
  })
})

/**
 * A task told to finish without review must finish with no window open.
 *
 * This used to be done by the renderer, watching for ready_for_review — so a
 * task could only self-resolve while a window happened to be open. An agent
 * driving 20x through MCP would leave it in review for ever.
 */
describe('AgentManager transitionToIdle — completing without review', () => {
  function makeDb(taskOverrides: Record<string, unknown> = {}) {
    const task = {
      id: 'task-1',
      title: 'Self-resolving task',
      repos: [],
      skill_ids: [],
      status: TaskStatus.AgentWorking,
      source_id: null,
      output_fields: [],
      auto_complete_without_review: true,
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
      getTranscriptParts: vi.fn(() => [] as Array<{ role: string; content: string }>),
    } as unknown as ConstructorParameters<typeof AgentManager>[0]
  }

  function setup(mockDb: ReturnType<typeof makeDb>) {
    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    vi.spyOn(mgr as any, 'extractOutputValues').mockResolvedValue(undefined)
    vi.spyOn(mgr as any, 'autoEnableHeartbeat').mockImplementation(() => undefined)
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

  it('completes the task in main, with no renderer involved', async () => {
    const mockDb = makeDb()
    const { mgr, session } = setup(mockDb)

    await (mgr as any).transitionToIdle('session-1', session)

    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
    expect(mockDb.updateTask).not.toHaveBeenCalledWith('task-1', { status: TaskStatus.ReadyForReview })
  })

  it('leaves an unflagged task for review, as before', async () => {
    const mockDb = makeDb({ auto_complete_without_review: false })
    const { mgr, session } = setup(mockDb)

    await (mgr as any).transitionToIdle('session-1', session)

    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.ReadyForReview })
    expect(mockDb.updateTask).not.toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
  })

  it('tells the source system before completing an enterprise task', async () => {
    const mockDb = makeDb({ source_id: 'source-1' })
    const { mgr, session } = setup(mockDb)
    const syncManager = { executeAction: vi.fn().mockResolvedValue({ success: true }) }
    mgr.setSyncManager(syncManager as any)

    await (mgr as any).transitionToIdle('session-1', session)

    expect(syncManager.executeAction).toHaveBeenCalledWith(
      'complete',
      expect.objectContaining({ id: 'task-1' }),
      undefined,
      'source-1'
    )
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
  })

  it('never marks it done locally when the source system refuses', async () => {
    const mockDb = makeDb({ source_id: 'source-1' })
    const { mgr, session } = setup(mockDb)
    const syncManager = {
      executeAction: vi.fn().mockResolvedValue({ success: false, error: 'upstream rejected' }),
    }
    mgr.setSyncManager(syncManager as any)

    await (mgr as any).transitionToIdle('session-1', session)

    // Completed there but not here would leave the two systems disagreeing.
    expect(mockDb.updateTask).toHaveBeenCalledWith('task-1', { status: TaskStatus.ReadyForReview })
    expect(mockDb.updateTask).not.toHaveBeenCalledWith('task-1', { status: TaskStatus.Completed })
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
      getTranscriptParts: vi.fn(() => [] as Array<{ role: string; content: string }>),
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

  it('does NOT re-emit a message already persisted under a different part id (codex id-scheme mismatch)', async () => {
    const mockDb = createEnterpriseTaskDb({ status: TaskStatus.AgentWorking, output_fields: [], source_id: null })
    // The projection already has this assistant message — captured live under a
    // codex streaming id (agent-msg_...). getAllMessages returns the SAME text
    // under the finalized item id (agent-item-42), which is NOT in seenPartIds.
    ;(mockDb as any).getTranscriptParts = vi.fn(() => [
      { role: 'assistant', content: 'I confirmed the production path has more than one worker.' }
    ])
    const { mgr, session } = setupManager(mockDb)
    const adapter = {
      getAllMessages: vi.fn(async () => ([
        {
          id: 'msg-1',
          role: MessageRole.ASSISTANT,
          parts: [
            { id: 'agent-item-42', type: MessagePartType.TEXT, text: 'I confirmed the production path has more than one worker.', content: 'I confirmed the production path has more than one worker.' },
            { id: 'agent-item-43', type: MessagePartType.TEXT, text: 'Brand new content not seen before.', content: 'Brand new content not seen before.' }
          ]
        }
      ]))
    }
    const sessionWithAdapter = { ...session, adapter: adapter as any }
    vi.spyOn(mgr as any, 'extractOutputValues').mockResolvedValue(undefined)
    const sendSpy = vi.spyOn(mgr as any, 'sendToRenderer')

    await (mgr as any).transitionToIdle('session-1', sessionWithAdapter)

    const batch = sendSpy.mock.calls.find(([channel]) => channel === 'agent:output-batch')?.[1] as
      | { messages: Array<{ id: string; content: string }> }
      | undefined
    const emittedIds = batch?.messages.map((m) => m.id) ?? []
    // The already-persisted message (different id) must NOT be re-emitted…
    expect(emittedIds).not.toContain('agent-item-42')
    // …but genuinely new content still is.
    expect(emittedIds).toContain('agent-item-43')
    // The skipped part's id is remembered so it isn't reconsidered next idle.
    expect(sessionWithAdapter.seenPartIds.has('agent-item-42')).toBe(true)
  })

  it('does not replay the final assistant text after idle when only the persisted part id changed (assistantTextKeys dedup)', async () => {
    const mockDb = createEnterpriseTaskDb({
      status: TaskStatus.AgentWorking,
      output_fields: [],
      source_id: null,
    })
    const { mgr, session } = setupManager(mockDb)
    const finalText = 'Investigation complete. The requested list contains 74 IDs, not 73. Root cause is documented.'
    const adapter = {
      getAllMessages: vi.fn(async () => ([
        {
          id: 'msg-1',
          role: MessageRole.ASSISTANT,
          parts: [
            { id: 'persisted-final-different-id', type: MessagePartType.TEXT, text: finalText, content: finalText }
          ]
        }
      ]))
    }

    const sessionWithAdapter = {
      ...session,
      adapter: adapter as any,
      seenPartIds: new Set<string>(['live-final-id']),
      assistantTextKeys: new Set<string>([finalText])
    }
    vi.spyOn(mgr as any, 'extractOutputValues').mockResolvedValue(undefined)

    const sendSpy = vi.spyOn(mgr as any, 'sendToRenderer')

    await (mgr as any).transitionToIdle('session-1', sessionWithAdapter)

    const replayCalls = sendSpy.mock.calls.filter(
      ([channel, payload]) => channel === 'agent:output-batch'
        && (payload as any)?.messages?.some((msg: any) => msg.content === finalText)
    )

    expect(adapter.getAllMessages).toHaveBeenCalledOnce()
    expect(replayCalls).toHaveLength(0)
    expect(sessionWithAdapter.seenPartIds.has('persisted-final-different-id')).toBe(true)
  })

  it('keeps polling and does not mark ready when adapter is still busy after transcript replay', async () => {
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
            { id: 'late-progress', type: MessagePartType.TEXT, text: 'Still verifying', content: 'Still verifying' }
          ]
        }
      ])),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      pollMessages: vi.fn(async () => [] as any[]),
    }

    const sessionWithAdapter = {
      ...session,
      adapter: adapter as any,
      workspaceDir: '/tmp/test-workspace'
    }
    vi.spyOn(mgr as any, 'extractOutputValues').mockResolvedValue(undefined)
    vi.spyOn(mgr as any, 'ensurePollingCoordinator').mockImplementation(() => undefined)

    await (mgr as any).transitionToIdle('session-1', sessionWithAdapter)

    expect(adapter.getAllMessages).toHaveBeenCalledOnce()
    expect(adapter.getStatus).toHaveBeenCalledOnce()
    expect(mockDb.updateTask).not.toHaveBeenCalledWith('task-1', { status: TaskStatus.ReadyForReview })
    expect((mgr as any).pollingEntries.has('session-1')).toBe(true)
    expect(sessionWithAdapter.status).toBe('working')
  })

  it('stores actual text content in partContentLengths, not string length (regression: number prefix bug)', async () => {
    // Regression: partContentLengths stored String(text.length) (e.g. "133")
    // instead of actual text. When chunk accumulation read it back, the number
    // was prepended to the next streamed chunk: "133Fixed and pushed..."
    const mockDb = createEnterpriseTaskDb({
      status: TaskStatus.AgentWorking,
      output_fields: [],
      source_id: null,
    })
    const { mgr, session } = setupManager(mockDb)
    const partText = 'This is the actual message content that should be stored'
    const adapter = {
      getAllMessages: vi.fn(async () => ([
        {
          id: 'msg-1',
          role: MessageRole.ASSISTANT,
          parts: [
            { id: 'text-part-1', type: MessagePartType.TEXT, text: partText, content: partText }
          ]
        }
      ]))
    }

    const sessionWithAdapter = {
      ...session,
      adapter: adapter as any
    }
    vi.spyOn(mgr as any, 'extractOutputValues').mockResolvedValue(undefined)
    vi.spyOn(mgr as any, 'sendToRenderer')

    await (mgr as any).transitionToIdle('session-1', sessionWithAdapter)

    // partContentLengths should store the ACTUAL text, not its length
    const storedValue = sessionWithAdapter.partContentLengths.get('text-part-1')
    expect(storedValue).toBe(partText)
    // Must NOT be the string representation of the length
    expect(storedValue).not.toBe(String(partText.length))
  })

  it('resumeAdapterSession seeds dedup state from resumed history without replaying to clients', async () => {
    // Resume builds the in-memory dedup state (seenMessageIds / seenPartIds) so
    // adapter polling won't re-emit historical parts as new streaming output.
    // It must NOT push a transcript batch to clients — the projection (snapshot
    // + `transcript:changed` deltas) is the sole render source.
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
      getMcpServers: vi.fn(() => []),
    })

    await (mgr as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'session-1')

    // No transcript batch is pushed to clients on resume.
    const batchCall = sendSpy.mock.calls.find(
      ([channel]) => channel === 'agent:output-batch'
    )
    expect(batchCall).toBeUndefined()

    // The session's dedup state is seeded from the resumed history.
    const session = (mgr as any).sessions.get('session-1')
    expect(session).toBeDefined()

    // Both parts are tracked: the id-less part gets a generated id, the stable
    // part keeps its own id → two entries total.
    expect(session.seenPartIds.size).toBe(2)
    expect(session.seenPartIds.has('stable-part-id')).toBe(true)

    // Message-level IDs are tracked for codex-style message dedup.
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

  it('cleanupHeartbeatSession fully tears down heartbeat sessions without resetting task status', async () => {
    const mockDb = createMockDb()
    const mgr = new AgentManager(mockDb)
    const destroySession = vi.fn(async () => undefined)
    const heartbeatSession = {
      id: 'real-id',
      agentId: 'agent-1',
      taskId: 'heartbeat-task-1',
      status: 'idle',
      workspaceDir: '/tmp/workspace/task-1',
      adapter: { destroySession },
      pollingStarted: true,
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      secretSessionToken: 'secret-token',
    }

    ;(mgr as any).sessions.set('real-id', heartbeatSession)
    ;(mgr as any).sessionIdRedirects.set('temp-id', 'real-id')

    vi.spyOn(mgr as any, 'stopAdapterPolling').mockImplementation(() => undefined)
    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue({ destroySession })
    vi.spyOn(mgr as any, 'buildSessionConfig').mockResolvedValue({})

    await mgr.cleanupHeartbeatSession('task-1')

    expect(destroySession).toHaveBeenCalledWith('real-id', {})
    expect(unregisterSecretSession).toHaveBeenCalledWith('secret-token')
    expect((mgr as any).sessionIdRedirects.has('temp-id')).toBe(false)
    expect((mgr as any).sessions.has('real-id')).toBe(false)
    expect(mockDb.updateTask).not.toHaveBeenCalled()
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

describe('buildMessageWithAttachmentContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('includes attachment references and a bounded preview for small text files', () => {
    const mgr = new AgentManager(createMockDb({}))
    const session = { workspaceDir: '/tmp/ws' } as { workspaceDir: string }

    mockedExistsSync.mockImplementation((p: any) => String(p).includes('/tmp/ws/attachments/spec.md'))
    mockedReadFileSync.mockImplementation(() => 'A'.repeat(1500))

    const result = (mgr as any).buildMessageWithAttachmentContext(
      session,
      'Please use attached context',
      [{ id: 'att-1', filename: 'spec.md', size: 1024, mime_type: 'text/markdown' }]
    ) as string

    expect(result).toContain('Please use attached context')
    expect(result).toContain('- attachments/spec.md (text/markdown, 1.0 KB)')
    expect(result).toContain('Small text previews')
    expect(result).toContain('...[truncated]')
    expect(result.length).toBeLessThan(2600)
  })

  it('caps attachment references and reports omitted items', () => {
    const mgr = new AgentManager(createMockDb({}))
    const session = { workspaceDir: '/tmp/ws' } as { workspaceDir: string }
    const attachments = Array.from({ length: 12 }, (_, i) => ({
      id: `att-${i + 1}`,
      filename: `file-${i + 1}.txt`,
      size: 100,
      mime_type: 'text/plain'
    }))

    mockedExistsSync.mockReturnValue(false)
    const result = (mgr as any).buildMessageWithAttachmentContext(session, 'Use files', attachments) as string

    expect(result).toContain('... and 2 more attachment(s) omitted')
    expect((result.match(/- attachments\/file-/g) || []).length).toBe(10)
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
      getStatus: vi.fn(async () => ({ type: SessionStatusType.IDLE })),
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
    adapter.getStatus.mockResolvedValueOnce({ type: SessionStatusType.IDLE })

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
    adapter.getStatus.mockResolvedValueOnce({ type: SessionStatusType.BUSY })

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

  it('does not spam auto-abort messages when a stuck running tool remains visible after polling restarts', async () => {
    const mgr = buildManager()
    const startedAt = Date.now() - 240_000
    const abortPrompt = vi.fn(async () => undefined)
    const adapter = {
      pollMessages: vi.fn(async () => [] as any[]),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      getRunningTools: vi.fn(async () => [{
        partId: 'tool-call-1',
        toolName: 'commandExecution',
        startTime: startedAt,
        input: {}
      }]),
      abortPrompt,
    }

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const firstEntry = (mgr as any).pollingEntries.get('session-1')
    await (mgr as any).pollSingleSession(firstEntry)

    expect(abortPrompt).toHaveBeenCalledOnce()

    // Reproduce the reported spam path: polling starts again while the same
    // App Server running tool is still visible. The new PollingEntry has a
    // fresh watchdogFired=false, so the session-level one-shot guard must
    // suppress another chat error and abort attempt.
    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const secondEntry = (mgr as any).pollingEntries.get('session-1')
    await (mgr as any).pollSingleSession(secondEntry)

    const sendSpy = vi.mocked((mgr as any).sendToRenderer)
    const autoAbortMessages = sendSpy.mock.calls.filter(([channel, payload]) => (
      channel === 'agent:output' &&
      String((payload as any).data?.content || '').startsWith('Session auto-aborted:')
    ))

    expect(autoAbortMessages).toHaveLength(1)
    expect(autoAbortMessages[0][1]).toMatchObject({
      data: {
        content: expect.stringContaining('Tool "commandExecution" has been running')
      }
    })
    expect(abortPrompt).toHaveBeenCalledOnce()
  })

  it('suppresses auto-abort transcript messages for Codex app-server tools', async () => {
    const mgr = buildManager()
    const abortPrompt = vi.fn(async () => undefined)
    const adapter = {
      pollMessages: vi.fn(async () => [] as any[]),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      getRunningTools: vi.fn(async () => [{
        partId: 'tool-call-1',
        toolName: 'commandExecution',
        startTime: Date.now() - 240_000,
        input: {}
      }]),
      abortPrompt,
    }
    Object.defineProperty(adapter, 'constructor', {
      value: { name: 'CodexAppServerAdapter' },
    })

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    await (mgr as any).pollSingleSession(entry)

    const sendSpy = vi.mocked((mgr as any).sendToRenderer)
    const autoAbortMessages = sendSpy.mock.calls.filter(([channel, payload]) => (
      channel === 'agent:output' &&
      String((payload as any).data?.content || '').startsWith('Session auto-aborted:')
    ))

    expect(autoAbortMessages).toHaveLength(0)
    expect(abortPrompt).toHaveBeenCalledOnce()
  })

  it('pollSingleSession does not inject a duplicate status error when the poll already emitted the same error text', async () => {
    const mgr = buildManager()
    const errorMessage = 'API Error: Server is temporarily limiting requests (not your usage limit) - Rate limited'
    const adapter = {
      pollMessages: vi.fn(async () => [
        {
          id: 'provider-error',
          role: 'assistant',
          type: MessagePartType.ERROR,
          content: errorMessage,
          receivedAt: Date.now(),
        }
      ] as any[]),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.ERROR, message: errorMessage })),
    }

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    await (mgr as any).pollSingleSession(entry)

    const sendSpy = vi.mocked((mgr as any).sendToRenderer)
    const outputBatchCalls = sendSpy.mock.calls.filter(([channel]) => channel === 'agent:output-batch')
    const outputCalls = sendSpy.mock.calls.filter(([channel]) => channel === 'agent:output')
    const statusCalls = sendSpy.mock.calls.filter(([channel]) => channel === 'agent:status')

    expect(outputBatchCalls).toHaveLength(1)
    expect((outputBatchCalls[0][1] as any).messages).toEqual([
      expect.objectContaining({ id: 'provider-error', content: errorMessage })
    ])
    expect(outputCalls).toHaveLength(0)
    expect(statusCalls).toEqual([
      ['agent:status', expect.objectContaining({ status: 'error' })]
    ])
  })

  it('pollSingleSession transitions to idle after BUSY then IDLE (work completed)', async () => {
    const mgr = buildManager()
    const adapter = buildAdapter()
    const finalText = 'Investigation complete. The final assistant answer was emitted from live polling before idle replay.'

    // First poll: BUSY
    adapter.pollMessages.mockResolvedValueOnce([
      { id: 'resp-1', role: 'assistant', content: finalText, type: 'text' }
    ])
    adapter.getStatus.mockResolvedValueOnce({ type: SessionStatusType.BUSY })

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

    // Second poll: IDLE after real work → transition.
    // Move lastPartReceivedAt into the past so the POST_DATA_GRACE_MS
    // (5 s) check doesn't block the transition.
    entry.lastPartReceivedAt = Date.now() - 10_000
    adapter.pollMessages.mockResolvedValueOnce([])
    adapter.getStatus.mockResolvedValueOnce({ type: SessionStatusType.IDLE })
    await (mgr as any).pollSingleSession(entry)
    expect(transitionSpy).toHaveBeenCalledOnce()
    const transitionSession = transitionSpy.mock.calls[0][1] as { assistantTextKeys: Set<string> }
    expect(transitionSession.assistantTextKeys.has(finalText)).toBe(true)
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

describe('AgentManager tillDone nudge on idle', () => {
  function buildManager() {
    const mockDb = createMockDb({})
    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    vi.spyOn(mgr as any, 'ensurePollingCoordinator').mockImplementation(() => undefined)
    return mgr
  }

  it('sends a nudge instead of transitioning to idle when session has incomplete todos', async () => {
    const mgr = buildManager()
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.IDLE })),
    }

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working' as const,
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
      // Todos captured from todowrite tool calls during polling
      todos: [
        { content: 'fix bug', status: 'in_progress' },
        { content: 'write tests', status: 'pending' },
        { content: 'setup CI', status: 'completed' }
      ]
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    // Make the session old enough to pass grace periods
    entry.createdAt = Date.now() - 30_000
    entry.hasSeenWork = true

    const transitionSpy = vi.spyOn(mgr as any, 'transitionToIdle').mockResolvedValue(undefined)
    const sendSpy = vi.spyOn(mgr as any, 'doSendAdapterMessage').mockResolvedValue(undefined)

    await (mgr as any).pollSingleSession(entry)

    // Should NOT transition to idle
    expect(transitionSpy).not.toHaveBeenCalled()
    // Should send a nudge message containing the incomplete items
    expect(sendSpy).toHaveBeenCalledOnce()
    const nudgeText = sendSpy.mock.calls[0][2] as string
    expect(nudgeText).toContain('fix bug')
    expect(nudgeText).toContain('write tests')
    expect(nudgeText).toContain('Remaining items')
    expect(nudgeText).toContain('1/3 completed')
    // Completed items should not appear in remaining
    expect(nudgeText).not.toContain('setup CI')
    // Nudge count should be incremented
    expect(entry.tillDoneNudgeCount).toBe(1)
  })

  it('transitions to idle normally when all todos are completed', async () => {
    const mgr = buildManager()
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.IDLE })),
    }

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working' as const,
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
      todos: [
        { content: 'fix bug', status: 'completed' },
        { content: 'write tests', status: 'done' }
      ]
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.createdAt = Date.now() - 30_000
    entry.hasSeenWork = true

    const transitionSpy = vi.spyOn(mgr as any, 'transitionToIdle').mockResolvedValue(undefined)
    vi.spyOn(mgr as any, 'stopAdapterPolling').mockImplementation(() => undefined)
    const sendSpy = vi.spyOn(mgr as any, 'doSendAdapterMessage').mockResolvedValue(undefined)

    await (mgr as any).pollSingleSession(entry)

    expect(transitionSpy).toHaveBeenCalledOnce()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('stops nudging after MAX_TILLDONE_NUDGES and transitions to idle', async () => {
    const mgr = buildManager()
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.IDLE })),
    }

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working' as const,
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
      todos: [{ content: 'stuck task', status: 'pending' }]
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.createdAt = Date.now() - 30_000
    entry.hasSeenWork = true
    // Simulate having already nudged the max number of times
    entry.tillDoneNudgeCount = (AgentManager as any).MAX_TILLDONE_NUDGES

    const transitionSpy = vi.spyOn(mgr as any, 'transitionToIdle').mockResolvedValue(undefined)
    vi.spyOn(mgr as any, 'stopAdapterPolling').mockImplementation(() => undefined)
    const sendSpy = vi.spyOn(mgr as any, 'doSendAdapterMessage').mockResolvedValue(undefined)

    await (mgr as any).pollSingleSession(entry)

    // Should transition to idle since nudge limit is reached
    expect(transitionSpy).toHaveBeenCalledOnce()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('resets tillDoneNudgeCount when session goes back to BUSY', async () => {
    const mgr = buildManager()
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
    }

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working' as const,
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
      todos: [{ content: 'some task', status: 'pending' }]
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.tillDoneNudgeCount = 3

    await (mgr as any).pollSingleSession(entry)

    // BUSY resets the nudge counter
    expect(entry.tillDoneNudgeCount).toBe(0)
  })

  it('end-to-end: captures todos from polled messages, nudges on idle, then transitions when done', async () => {
    const mgr = buildManager()

    // Step 1: Agent is working and creates a todo list via todowrite
    let statusType = SessionStatusType.BUSY
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: statusType })),
    }

    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working' as const,
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
    }
    ;(mgr as any).sessions.set('session-1', session)

    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )

    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.createdAt = Date.now() - 30_000
    entry.hasSeenWork = true

    // Agent polls back a todowrite tool call with 3 items
    adapter.pollMessages.mockResolvedValueOnce([
      {
        id: 'part-todo-1',
        role: 'assistant',
        type: 'todowrite',
        content: 'Todo List',
        tool: {
          name: 'TodoWrite',
          status: 'success',
          todos: [
            { id: '1', content: 'write unit tests', status: 'in_progress' },
            { id: '2', content: 'fix linting errors', status: 'pending' },
            { id: '3', content: 'update README', status: 'pending' }
          ]
        }
      }
    ] as any)

    // Poll while BUSY — should capture todos onto session
    await (mgr as any).pollSingleSession(entry)
    expect((session as any).todos).toEqual([
      { content: 'write unit tests', status: 'in_progress' },
      { content: 'fix linting errors', status: 'pending' },
      { content: 'update README', status: 'pending' }
    ])

    // Step 2: Agent goes idle WITHOUT finishing todos
    statusType = SessionStatusType.IDLE
    adapter.pollMessages.mockResolvedValueOnce([])
    // Clear the post-data grace timer so idle detection isn't skipped
    entry.lastPartReceivedAt = Date.now() - 10_000

    const transitionSpy = vi.spyOn(mgr as any, 'transitionToIdle').mockResolvedValue(undefined)
    const sendSpy = vi.spyOn(mgr as any, 'doSendAdapterMessage').mockResolvedValue(undefined)

    await (mgr as any).pollSingleSession(entry)

    // Should NOT transition — should nudge instead
    expect(transitionSpy).not.toHaveBeenCalled()
    expect(sendSpy).toHaveBeenCalledOnce()
    const nudgeText = sendSpy.mock.calls[0][2] as string
    expect(nudgeText).toContain('0/3 completed')
    expect(nudgeText).toContain('[in_progress] write unit tests')
    expect(nudgeText).toContain('[pending] fix linting errors')
    expect(nudgeText).toContain('[pending] update README')
    expect(entry.tillDoneNudgeCount).toBe(1)

    // Step 3: Agent resumes work (BUSY), completes all todos
    statusType = SessionStatusType.BUSY
    sendSpy.mockClear()
    transitionSpy.mockClear()

    adapter.pollMessages.mockResolvedValueOnce([
      {
        id: 'part-todo-2',
        role: 'assistant',
        type: 'todowrite',
        content: 'Todo List',
        tool: {
          name: 'TodoWrite',
          status: 'success',
          todos: [
            { id: '1', content: 'write unit tests', status: 'completed' },
            { id: '2', content: 'fix linting errors', status: 'completed' },
            { id: '3', content: 'update README', status: 'completed' }
          ]
        }
      }
    ] as any)

    await (mgr as any).pollSingleSession(entry)
    // Nudge counter should reset on BUSY
    expect(entry.tillDoneNudgeCount).toBe(0)
    // Todos should be updated to all completed
    expect((session as any).todos).toEqual([
      { content: 'write unit tests', status: 'completed' },
      { content: 'fix linting errors', status: 'completed' },
      { content: 'update README', status: 'completed' }
    ])

    // Step 4: Agent goes idle again — all todos done, should transition normally
    statusType = SessionStatusType.IDLE
    adapter.pollMessages.mockResolvedValueOnce([])
    entry.lastPartReceivedAt = Date.now() - 10_000
    vi.spyOn(mgr as any, 'stopAdapterPolling').mockImplementation(() => undefined)

    await (mgr as any).pollSingleSession(entry)

    // Should transition to idle (all done) — no nudge
    expect(transitionSpy).toHaveBeenCalledOnce()
    expect(sendSpy).not.toHaveBeenCalled()
  })
})

describe('AgentManager delegation-aware watchdogs', () => {
  function buildManager(dbOverrides: Record<string, unknown> = {}) {
    const mockDb = createMockDb({})
    Object.assign(mockDb as any, dbOverrides)
    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    vi.spyOn(mgr as any, 'ensurePollingCoordinator').mockImplementation(() => undefined)
    return { mgr, mockDb }
  }

  function buildBusySession(mgr: AgentManager, adapter: Record<string, unknown>) {
    const session = {
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'working' as const,
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      adapter,
      pollingStarted: true,
    }
    ;(mgr as any).sessions.set('session-1', session)
    ;(mgr as any).startAdapterPolling(
      'session-1',
      adapter,
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' },
      undefined,
      session
    )
    const entry = (mgr as any).pollingEntries.get('session-1')
    entry.hasSeenWork = true
    return { session, entry }
  }

  it('classifies delegation tools correctly', () => {
    const isDelegation = (AgentManager as any).isDelegationTool.bind(AgentManager)
    // Subagent spawn tools
    expect(isDelegation('task')).toBe(true)
    expect(isDelegation('Task')).toBe(true)
    expect(isDelegation('agent')).toBe(true)
    // Subtask orchestration tools (various MCP name manglings)
    expect(isDelegation('wait_for_subtasks')).toBe(true)
    expect(isDelegation('mcp__task-management__wait_for_subtasks')).toBe(true)
    expect(isDelegation('task-management_wait_for_subtasks')).toBe(true)
    expect(isDelegation('start_task')).toBe(true)
    // Ordinary tools are not delegation
    expect(isDelegation('read')).toBe(false)
    expect(isDelegation('bash')).toBe(false)
    expect(isDelegation('todowrite')).toBe(false)
    expect(isDelegation(undefined)).toBe(false)
  })

  it('stuck-tool detector does NOT abort a long-running delegation tool', async () => {
    const { mgr } = buildManager()
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      getRunningTools: vi.fn(async () => [
        // Running for 10 minutes — way past STUCK_TOOL_TIMEOUT_MS (90s)
        { partId: 'p1', toolName: 'mcp__task-management__wait_for_subtasks', startTime: Date.now() - 10 * 60_000 },
      ]),
      abortPrompt: vi.fn(async () => undefined),
    }
    const { entry } = buildBusySession(mgr, adapter)
    entry.createdAt = Date.now() - 60_000
    entry.lastPartReceivedAt = Date.now() - 60_000 // recent enough for session watchdog

    await (mgr as any).pollSingleSession(entry)

    expect(adapter.abortPrompt).not.toHaveBeenCalled()
    expect(entry.watchdogFired).toBeFalsy()
  })

  it('stuck-tool detector still aborts a hung non-delegation tool', async () => {
    const { mgr } = buildManager()
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      getRunningTools: vi.fn(async () => [
        { partId: 'p1', toolName: 'read', startTime: Date.now() - 5 * 60_000 },
      ]),
      abortPrompt: vi.fn(async () => undefined),
    }
    const { entry } = buildBusySession(mgr, adapter)
    entry.createdAt = Date.now() - 60_000
    entry.lastPartReceivedAt = Date.now() - 60_000
    vi.spyOn(mgr as any, 'sendAutoAbortMessageOnce').mockReturnValue(true)

    await (mgr as any).pollSingleSession(entry)

    expect(adapter.abortPrompt).toHaveBeenCalledOnce()
    expect(entry.watchdogFired).toBe(true)
  })

  it('stuck-session watchdog stands down while a delegation tool is running', async () => {
    const { mgr } = buildManager()
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      getRunningTools: vi.fn(async () => [
        { partId: 'p1', toolName: 'task', startTime: Date.now() - 30_000 },
      ]),
      abortPrompt: vi.fn(async () => undefined),
    }
    const { entry } = buildBusySession(mgr, adapter)
    // Silent for 6 minutes — past STUCK_SESSION_TIMEOUT_MS (5 min)
    entry.createdAt = Date.now() - 10 * 60_000
    entry.lastPartReceivedAt = Date.now() - 6 * 60_000

    await (mgr as any).pollSingleSession(entry)

    expect(adapter.abortPrompt).not.toHaveBeenCalled()
    expect(entry.watchdogFired).toBeFalsy()
  })

  it('stuck-session watchdog stands down while subtasks are still being worked on', async () => {
    const { mgr, mockDb } = buildManager()
    ;(mockDb as any).getSubtasks = vi.fn(() => [
      { id: 'sub-1', title: 'Child A', status: TaskStatus.AgentWorking },
      { id: 'sub-2', title: 'Child B', status: TaskStatus.ReadyForReview },
    ])
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      abortPrompt: vi.fn(async () => undefined),
    }
    const { entry } = buildBusySession(mgr, adapter)
    entry.createdAt = Date.now() - 10 * 60_000
    entry.lastPartReceivedAt = Date.now() - 6 * 60_000

    await (mgr as any).pollSingleSession(entry)

    expect(adapter.abortPrompt).not.toHaveBeenCalled()
    expect(entry.watchdogFired).toBeFalsy()
  })

  it('stuck-session watchdog still aborts a truly silent session with no delegation', async () => {
    const { mgr } = buildManager()
    const adapter = {
      pollMessages: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })),
      abortPrompt: vi.fn(async () => undefined),
    }
    const { entry } = buildBusySession(mgr, adapter)
    entry.createdAt = Date.now() - 10 * 60_000
    entry.lastPartReceivedAt = Date.now() - 6 * 60_000
    vi.spyOn(mgr as any, 'sendAutoAbortMessageOnce').mockReturnValue(true)

    await (mgr as any).pollSingleSession(entry)

    expect(adapter.abortPrompt).toHaveBeenCalledOnce()
    expect(entry.watchdogFired).toBe(true)
  })
})

describe('AgentManager idle-session inactivity reaper', () => {
  const THIRTY_ONE_MINUTES = 31 * 60_000

  function buildManager(dbOverrides: Record<string, unknown> = {}) {
    const mockDb = createMockDb({})
    Object.assign(mockDb as any, {
      getTask: vi.fn(() => ({ id: 'task-1', title: 'Test Task', repos: [], skill_ids: [], session_id: 'session-1', status: TaskStatus.ReadyForReview })),
      ...dbOverrides,
    })
    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    const stopSpy = vi.spyOn(mgr, 'stopSession').mockResolvedValue(undefined)
    return { mgr, mockDb, stopSpy }
  }

  function addSession(mgr: AgentManager, overrides: Record<string, unknown> = {}) {
    const session = {
      id: 'session-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'idle' as const,
      createdAt: new Date(Date.now() - THIRTY_ONE_MINUTES),
      lastActivityAt: Date.now() - THIRTY_ONE_MINUTES,
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      ...overrides,
    }
    ;(mgr as any).sessions.set((overrides.id as string) || 'session-1', session)
    return session
  }

  it('releases the runtime of a long-idle session (resume-capable)', async () => {
    const { mgr, stopSpy } = buildManager()
    addSession(mgr)

    await (mgr as any).reapInactiveSessions()

    // resetTaskStatus=false: this is a resource release, not a user stop
    expect(stopSpy).toHaveBeenCalledWith('session-1', false)
  })

  it('never touches a session with an active turn', async () => {
    const { mgr, stopSpy } = buildManager()
    addSession(mgr, { status: 'working' })

    await (mgr as any).reapInactiveSessions()

    expect(stopSpy).not.toHaveBeenCalled()
  })

  it('does not release a recently idle session', async () => {
    const { mgr, stopSpy } = buildManager()
    addSession(mgr, { lastActivityAt: Date.now() - 60_000 })

    await (mgr as any).reapInactiveSessions()

    expect(stopSpy).not.toHaveBeenCalled()
  })

  it('does not release a coordinator whose subtasks are still being worked on', async () => {
    const { mgr, mockDb, stopSpy } = buildManager()
    ;(mockDb as any).getSubtasks = vi.fn(() => [
      { id: 'sub-1', title: 'Child A', status: TaskStatus.AgentWorking },
    ])
    addSession(mgr)

    await (mgr as any).reapInactiveSessions()

    expect(stopSpy).not.toHaveBeenCalled()
  })

  it('skips pseudo-task sessions (no DB row) and sessions without a resume anchor', async () => {
    const { mgr, mockDb, stopSpy } = buildManager()
    // No DB row (mastermind / heartbeat pseudo-tasks)
    ;(mockDb as any).getTask = vi.fn(() => undefined)
    addSession(mgr)
    await (mgr as any).reapInactiveSessions()
    expect(stopSpy).not.toHaveBeenCalled()

    // DB row exists but has no persisted session_id to resume from
    ;(mockDb as any).getTask = vi.fn(() => ({ id: 'task-1', title: 'Test Task', session_id: null }))
    await (mgr as any).reapInactiveSessions()
    expect(stopSpy).not.toHaveBeenCalled()
  })
})

describe('AgentManager event-driven parent wake-up', () => {
  function buildManager(tasks: Record<string, Record<string, unknown>>, subtasks: Record<string, unknown>[]) {
    const mockDb = createMockDb({})
    Object.assign(mockDb as any, {
      getTask: vi.fn((id: string) => tasks[id]),
      getSubtasks: vi.fn(() => subtasks),
    })
    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    const wakeSpy = vi.spyOn(mgr, 'sendByTaskId').mockResolvedValue({ sessionId: 'parent-session' })
    return { mgr, mockDb, wakeSpy }
  }

  const parentTask = { id: 'parent-1', title: 'Parent', status: TaskStatus.ReadyForReview }

  it('wakes an idle parent when all subtasks reach a terminal state', async () => {
    const { mgr, wakeSpy } = buildManager({ 'parent-1': parentTask }, [
      { id: 'sub-1', title: 'Child A', status: TaskStatus.ReadyForReview },
      { id: 'sub-2', title: 'Child B', status: TaskStatus.Completed },
    ])

    await mgr.notifyParentOfSubtaskCompletion('parent-1', 'sub-1')

    expect(wakeSpy).toHaveBeenCalledOnce()
    const [taskId, message] = wakeSpy.mock.calls[0]
    expect(taskId).toBe('parent-1')
    expect(message).toContain('Child A')
    expect(message).toContain('Child B')
    expect(message).toContain('terminal state')
  })

  it('does not wake the parent while some subtasks are still active', async () => {
    const { mgr, wakeSpy } = buildManager({ 'parent-1': parentTask }, [
      { id: 'sub-1', title: 'Child A', status: TaskStatus.ReadyForReview },
      { id: 'sub-2', title: 'Child B', status: TaskStatus.AgentWorking },
    ])

    await mgr.notifyParentOfSubtaskCompletion('parent-1', 'sub-1')

    expect(wakeSpy).not.toHaveBeenCalled()
  })

  it('does not inject a message while the parent session is actively working', async () => {
    const { mgr, wakeSpy } = buildManager({ 'parent-1': parentTask }, [
      { id: 'sub-1', title: 'Child A', status: TaskStatus.ReadyForReview },
    ])
    ;(mgr as any).sessions.set('parent-session', {
      id: 'parent-session',
      agentId: 'agent-1',
      taskId: 'parent-1',
      status: 'working',
      createdAt: new Date(),
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
    })

    await mgr.notifyParentOfSubtaskCompletion('parent-1', 'sub-1')

    expect(wakeSpy).not.toHaveBeenCalled()
  })

  it('does not wake a completed parent task', async () => {
    const { mgr, wakeSpy } = buildManager(
      { 'parent-1': { ...parentTask, status: TaskStatus.Completed } },
      [{ id: 'sub-1', title: 'Child A', status: TaskStatus.Completed }]
    )

    await mgr.notifyParentOfSubtaskCompletion('parent-1', 'sub-1')

    expect(wakeSpy).not.toHaveBeenCalled()
  })
})

describe('AgentManager durable transcript write-through', () => {
  function buildManager() {
    const mockDb = createMockDb({})
    const upserted: Array<{ taskId: string; parts: Array<{ id: string; role?: string; content?: string; partType?: string }> }> = []
    Object.assign(mockDb as any, {
      upsertTranscriptParts: vi.fn((taskId: string, parts: never[]) => {
        upserted.push({ taskId, parts })
        return { maxRev: upserted.length, changedPartIds: [] }
      }),
      hasTranscriptParts: vi.fn(() => false),
      getTranscriptParts: vi.fn(() => [])
    })
    const mgr = new AgentManager(mockDb)
    // Avoid electron window access; keep persist path (sendToRenderer) intact
    ;(mgr as any).mainWindow = null
    return { mgr, mockDb, upserted }
  }

  it('persists agent:output parts before delivery', () => {
    const { mgr, upserted } = buildManager()
    ;(mgr as any).sendToRenderer('agent:output', {
      sessionId: 's1',
      taskId: 'task-1',
      type: 'message',
      data: { id: 'p1', role: 'assistant', content: 'ACK — woke up on completion', partType: 'text' }
    })

    expect(upserted).toHaveLength(1)
    expect(upserted[0].taskId).toBe('task-1')
    expect(upserted[0].parts[0]).toMatchObject({ id: 'p1', role: 'assistant', content: 'ACK — woke up on completion' })
  })

  it('persists agent:output-batch parts and skips ephemeral part types', () => {
    const { mgr, upserted } = buildManager()
    ;(mgr as any).sendToRenderer('agent:output-batch', {
      sessionId: 's1',
      taskId: 'task-1',
      messages: [
        { id: 'p1', role: 'assistant', content: 'real output', partType: 'text' },
        { id: 'p2', role: 'system', content: 'x', partType: 'step-start' },
        { id: 'p3', role: 'system', content: 'y', partType: 'step-finish' },
        { id: 'p4', role: 'system', content: '', partType: 'text' } // empty, no structure
      ]
    })

    expect(upserted).toHaveLength(1)
    expect(upserted[0].parts.map((p) => p.id)).toEqual(['p1'])
  })

  it('always forwards live parts to the projection regardless of store population (idempotency is at the DB layer)', () => {
    const { mgr, mockDb, upserted } = buildManager()

    // A populated projection must NOT short-circuit live output — re-emit is a
    // no-op at the DB layer (upsert keyed by stable part id), not here.
    ;(mockDb as any).hasTranscriptParts = vi.fn(() => true)
    ;(mgr as any).sendToRenderer('agent:output-batch', {
      sessionId: 's1',
      taskId: 'task-1',
      messages: [{ id: 'p1', role: 'assistant', content: 'live output', partType: 'text' }]
    })
    expect(upserted).toHaveLength(1)
    expect(upserted[0].parts[0].id).toBe('p1')
  })

  it('exposes snapshots via getTranscriptSnapshot', async () => {
    const { mgr, mockDb } = buildManager()
    const rows = [{ taskId: 'task-1', partId: 'p1', seq: 1, role: 'assistant', content: 'hi', createdAt: 1, updatedAt: 1 }]
    ;(mockDb as any).hasTranscriptParts = vi.fn(() => true) // already populated → no backfill
    ;(mockDb as any).getTranscriptParts = vi.fn(() => rows)

    await expect(mgr.getTranscriptSnapshot('task-1')).resolves.toEqual(rows)
    expect((mockDb as any).getTranscriptParts).toHaveBeenCalledWith('task-1', undefined)
  })

  it('coalesces transcript:changed emissions per task behind one trailing delta read', () => {
    vi.useFakeTimers()
    try {
      const mockDb = createMockDb({})
      const sent: Array<{ channel: string; data: unknown }> = []
      let rev = 0
      Object.assign(mockDb as any, {
        upsertTranscriptParts: vi.fn((_taskId: string, parts: Array<{ id: string }>) => {
          rev += parts.length
          return { maxRev: rev, changedPartIds: parts.map((p) => p.id) }
        }),
        getTranscriptDelta: vi.fn((taskId: string, sinceRev: number) => ({
          maxRev: rev,
          parts: [
            { taskId, partId: 'p1', seq: 1, role: 'assistant', content: 'one', createdAt: 1, updatedAt: 1, rev: 1 },
            { taskId, partId: 'p2', seq: 2, role: 'assistant', content: 'two', createdAt: 2, updatedAt: 2, rev: 2 },
            { taskId, partId: 'p3', seq: 3, role: 'assistant', content: 'three', createdAt: 3, updatedAt: 3, rev: 3 }
          ].filter((p) => p.rev > sinceRev)
        }))
      })
      const mgr = new AgentManager(mockDb)
      mgr.addExternalListener((channel, data) => sent.push({ channel, data }))

      ;(mgr as any).sendToRenderer('agent:output', { taskId: 'task-1', data: { id: 'p1', role: 'assistant', content: 'one', partType: 'text' } })
      ;(mgr as any).sendToRenderer('agent:output', { taskId: 'task-1', data: { id: 'p2', role: 'assistant', content: 'two', partType: 'text' } })
      ;(mgr as any).sendToRenderer('agent:output', { taskId: 'task-1', data: { id: 'p3', role: 'assistant', content: 'three', partType: 'text' } })

      expect((mockDb as any).getTranscriptDelta).not.toHaveBeenCalled()
      expect(sent.filter((e) => e.channel === 'transcript:changed')).toHaveLength(0)

      vi.advanceTimersByTime(125)

      expect((mockDb as any).getTranscriptDelta).toHaveBeenCalledOnce()
      expect((mockDb as any).getTranscriptDelta).toHaveBeenCalledWith('task-1', 0)
      const transcriptEvents = sent.filter((e) => e.channel === 'transcript:changed')
      expect(transcriptEvents).toHaveLength(1)
      expect(transcriptEvents[0].data).toMatchObject({ taskId: 'task-1', maxRev: 3 })
      expect((transcriptEvents[0].data as { parts: Array<{ partId: string }> }).parts.map((p) => p.partId)).toEqual(['p1', 'p2', 'p3'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AgentManager transcript projection backfill (event-sourced, ingest-once)', () => {
  function buildManager() {
    const mockDb = createMockDb({})
    const upserts: Array<{ taskId: string; parts: Array<{ id: string; role?: string; content?: string; receivedAt?: number }> }> = []
    let stored = false
    Object.assign(mockDb as any, {
      getTask: vi.fn(() => ({ id: 'task-1', agent_id: 'agent-1', session_id: 'sess-abc', title: 'T', repos: [], skill_ids: [] })),
      getWorkspaceDir: vi.fn(() => '/tmp/ws'),
      hasTranscriptParts: vi.fn(() => stored),
      upsertTranscriptParts: vi.fn((taskId: string, parts: never[]) => { upserts.push({ taskId, parts }); stored = true }),
      getTranscriptParts: vi.fn(() => [])
    })
    const mgr = new AgentManager(mockDb)
    return { mgr, mockDb, upserts }
  }

  const persisted = [
    {
      role: MessageRole.USER,
      parts: [{ id: 'u1', type: MessagePartType.TEXT, text: 'hello', receivedAt: 1000 }]
    },
    {
      role: MessageRole.ASSISTANT,
      parts: [
        { id: 'a1', type: MessagePartType.TEXT, text: 'hi there', receivedAt: 2000 },
        { id: 's1', type: 'step-start', text: '', receivedAt: 2001 } // ephemeral, skipped
      ]
    }
  ]

  it('ingests persisted history once into the projection with real timestamps', async () => {
    const { mgr, upserts } = buildManager()
    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue({
      getPersistedMessages: vi.fn(async () => persisted)
    })

    await mgr.getTranscriptSnapshot('task-1')

    expect(upserts).toHaveLength(1)
    const ids = upserts[0].parts.map((p) => p.id)
    expect(ids).toEqual(['u1', 'a1']) // step-start ephemeral excluded
    expect(upserts[0].parts.find((p) => p.id === 'u1')).toMatchObject({ role: 'user', content: 'hello', receivedAt: 1000 })
    expect(upserts[0].parts.find((p) => p.id === 'a1')).toMatchObject({ role: 'assistant', receivedAt: 2000 })
  })

  it('does NOT ingest when the projection already has parts (reader connect is side-effect-free)', async () => {
    const { mgr, mockDb, upserts } = buildManager()
    // Projection is already populated by live write-through. A snapshot read
    // (e.g. a mobile client connecting) must NOT re-ingest the persisted session
    // — re-ingesting under mismatched ids duplicates messages, and the upsert
    // would broadcast those dupes to every client (including desktop).
    ;(mockDb as any).hasTranscriptParts = vi.fn(() => true)
    const getPersistedMessages = vi.fn(async () => persisted)
    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue({ getPersistedMessages })

    await mgr.getTranscriptSnapshot('task-1')

    expect(upserts).toHaveLength(0)                 // nothing written
    expect(getPersistedMessages).not.toHaveBeenCalled() // history not even read
  })

  it('seeds an empty projection with the full persisted history', async () => {
    const { mgr, upserts } = buildManager() // hasTranscriptParts starts false
    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue({
      getPersistedMessages: vi.fn(async () => persisted)
    })

    await mgr.getTranscriptSnapshot('task-1')

    expect(upserts).toHaveLength(1)
    expect(upserts[0].parts.map((p) => p.id)).toEqual(['u1', 'a1']) // step-start excluded
  })

  it('is idempotent per app run — a second snapshot call does not re-ingest', async () => {
    const { mgr, upserts } = buildManager()
    const getPersistedMessages = vi.fn(async () => persisted)
    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue({ getPersistedMessages })

    await mgr.getTranscriptSnapshot('task-1')
    await mgr.getTranscriptSnapshot('task-1')

    expect(upserts).toHaveLength(1) // ingested once this run
    expect(getPersistedMessages).toHaveBeenCalledTimes(1)
  })

  it('no-ops safely when the adapter cannot read persisted history', async () => {
    const { mgr, upserts } = buildManager()
    vi.spyOn(mgr as any, 'getAdapter').mockReturnValue({ /* no getPersistedMessages */ })

    const result = await mgr.getTranscriptSnapshot('task-1')

    expect(upserts).toHaveLength(0)
    expect(result).toEqual([])
  })
})

/**
 * Regression tests for: Claude Code backgrounds its Task-tool subagents, so the
 * coordinator's turn ends (session reports IDLE) while the children keep
 * working.  Two things must not happen:
 *   1. the inactivity reaper destroying the session (which aborts the query and
 *      kills the in-process subagents), and
 *   2. the children's later output being dropped because polling was stopped.
 */
describe('AgentManager background subagent protection', () => {
  const THIRTY_ONE_MINUTES = 31 * 60_000

  function buildManager(dbOverrides: Record<string, unknown> = {}) {
    const mockDb = createMockDb({})
    Object.assign(mockDb as any, {
      getTask: vi.fn(() => ({
        id: 'task-1', title: 'Test Task', repos: [], skill_ids: [],
        session_id: 'session-1', status: TaskStatus.ReadyForReview,
      })),
      getWorkspaceDir: vi.fn(() => '/tmp/ws'),
      updateTask: vi.fn(),
      ...dbOverrides,
    })
    const mgr = new AgentManager(mockDb)
    vi.spyOn(mgr as any, 'sendToRenderer').mockImplementation(() => undefined)
    return { mgr, mockDb }
  }

  function addSession(mgr: AgentManager, overrides: Record<string, unknown> = {}) {
    const session = {
      id: 'session-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      status: 'idle' as const,
      createdAt: new Date(Date.now() - THIRTY_ONE_MINUTES),
      lastActivityAt: Date.now() - THIRTY_ONE_MINUTES,
      seenMessageIds: new Set<string>(),
      seenPartIds: new Set<string>(),
      partContentLengths: new Map<string, string>(),
      ...overrides,
    }
    ;(mgr as any).sessions.set((overrides.id as string) || 'session-1', session)
    return session
  }

  describe('inactivity reaper vs in-process background subagents', () => {
    it('does not reap an idle session whose adapter still reports a running delegation tool', async () => {
      const { mgr } = buildManager()
      const stopSpy = vi.spyOn(mgr, 'stopSession').mockResolvedValue(undefined)
      addSession(mgr, {
        adapter: {
          // Claude Code background subagent still in flight
          getRunningTools: vi.fn(async () => [
            { partId: 'task-t1', toolName: 'task', startTime: Date.now() - 60_000 },
          ]),
        },
      })

      await (mgr as any).reapInactiveSessions()

      expect(stopSpy).not.toHaveBeenCalled()
    })

    it('still reaps an idle session whose background tasks have all drained', async () => {
      const { mgr } = buildManager()
      const stopSpy = vi.spyOn(mgr, 'stopSession').mockResolvedValue(undefined)
      addSession(mgr, { adapter: { getRunningTools: vi.fn(async () => []) } })

      await (mgr as any).reapInactiveSessions()

      expect(stopSpy).toHaveBeenCalledWith('session-1', false)
    })

    it('reaps normally when the adapter does not implement getRunningTools', async () => {
      const { mgr } = buildManager()
      const stopSpy = vi.spyOn(mgr, 'stopSession').mockResolvedValue(undefined)
      addSession(mgr, { adapter: {} })

      await (mgr as any).reapInactiveSessions()

      expect(stopSpy).toHaveBeenCalledWith('session-1', false)
    })

    it('does not let a throwing getRunningTools block reaping', async () => {
      const { mgr } = buildManager()
      const stopSpy = vi.spyOn(mgr, 'stopSession').mockResolvedValue(undefined)
      addSession(mgr, {
        adapter: { getRunningTools: vi.fn(async () => { throw new Error('boom') }) },
      })

      await (mgr as any).reapInactiveSessions()

      expect(stopSpy).toHaveBeenCalledWith('session-1', false)
    })
  })

  describe('wake-up on late adapter data', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0))

    it('re-registers polling when an already-idle session reports BUSY again', async () => {
      const { mgr, mockDb } = buildManager()
      const resumeSpy = vi
        .spyOn(mgr as any, 'resumeAdapterPollingAfterPrematureIdle')
        .mockImplementation(() => undefined)
      addSession(mgr, {
        adapter: { getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })) },
      })

      ;(mgr as any).wakeSessionOnAdapterData('session-1')
      await flush()

      expect(resumeSpy).toHaveBeenCalled()
      // The task was flipped to ready_for_review by transitionToIdle — put it back
      expect((mockDb as any).updateTask).toHaveBeenCalledWith('task-1', {
        status: TaskStatus.AgentWorking,
      })
    })

    it('re-registers polling during the gap before transitionToIdle marks the session idle', async () => {
      const { mgr } = buildManager()
      const resumeSpy = vi
        .spyOn(mgr as any, 'resumeAdapterPollingAfterPrematureIdle')
        .mockImplementation(() => undefined)
      const getStatus = vi.fn(async () => ({ type: SessionStatusType.BUSY }))
      addSession(mgr, {
        status: 'working',
        adapter: { getStatus },
      })

      // pollAdapterSession removes the polling entry before its asynchronous
      // transitionToIdle call changes this status. A push event can land here.
      ;(mgr as any).wakeSessionOnAdapterData('session-1')
      await flush()

      expect(getStatus).toHaveBeenCalledTimes(1)
      expect(resumeSpy).toHaveBeenCalledWith('session-1', expect.anything())
    })

    it('ignores trailing data from a session that is genuinely finished', async () => {
      const { mgr, mockDb } = buildManager()
      const resumeSpy = vi
        .spyOn(mgr as any, 'resumeAdapterPollingAfterPrematureIdle')
        .mockImplementation(() => undefined)
      addSession(mgr, {
        adapter: { getStatus: vi.fn(async () => ({ type: SessionStatusType.IDLE })) },
      })

      ;(mgr as any).wakeSessionOnAdapterData('session-1')
      await flush()

      expect(resumeSpy).not.toHaveBeenCalled()
      expect((mockDb as any).updateTask).not.toHaveBeenCalled()
    })

    it('does nothing when the session is still registered for polling', async () => {
      const { mgr } = buildManager()
      const resumeSpy = vi
        .spyOn(mgr as any, 'resumeAdapterPollingAfterPrematureIdle')
        .mockImplementation(() => undefined)
      const getStatus = vi.fn(async () => ({ type: SessionStatusType.BUSY }))
      addSession(mgr, { adapter: { getStatus } })
      ;(mgr as any).pollingEntries.set('session-1', { sessionId: 'session-1' })

      ;(mgr as any).wakeSessionOnAdapterData('session-1')
      await flush()

      expect(getStatus).not.toHaveBeenCalled()
      expect(resumeSpy).not.toHaveBeenCalled()
    })

    it('dedupes concurrent wake-ups for the same session', async () => {
      const { mgr } = buildManager()
      vi.spyOn(mgr as any, 'resumeAdapterPollingAfterPrematureIdle').mockImplementation(() => undefined)
      const getStatus = vi.fn(async () => ({ type: SessionStatusType.BUSY }))
      addSession(mgr, { adapter: { getStatus } })

      ;(mgr as any).wakeSessionOnAdapterData('session-1')
      ;(mgr as any).wakeSessionOnAdapterData('session-1')
      ;(mgr as any).wakeSessionOnAdapterData('session-1')
      await flush()

      expect(getStatus).toHaveBeenCalledTimes(1)
    })

    it('resolves a re-keyed session id through sessionIdRedirects', async () => {
      const { mgr } = buildManager()
      const resumeSpy = vi
        .spyOn(mgr as any, 'resumeAdapterPollingAfterPrematureIdle')
        .mockImplementation(() => undefined)
      addSession(mgr, {
        id: 'real-id',
        adapter: { getStatus: vi.fn(async () => ({ type: SessionStatusType.BUSY })) },
      })
      ;(mgr as any).sessionIdRedirects.set('temp-id', 'real-id')

      ;(mgr as any).wakeSessionOnAdapterData('temp-id')
      await flush()

      expect(resumeSpy).toHaveBeenCalledWith('real-id', expect.anything())
    })
  })
})
