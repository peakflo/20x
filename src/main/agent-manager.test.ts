/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentManager } from './agent-manager'
import { SessionStatus } from '../shared/constants'

// Mock filesystem operations
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
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

const mockedMkdirAsync = vi.mocked(mkdirAsync)
const mockedWriteFileAsync = vi.mocked(writeFileAsync)

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
