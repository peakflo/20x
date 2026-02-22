import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Notification } from 'electron'
import { AgentManager } from './agent-manager'

// Create a minimal mock DB
function createMockDb(): any {
  return {
    getAgents: vi.fn().mockReturnValue([]),
    getAgent: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    getSettings: vi.fn().mockReturnValue({}),
    getSetting: vi.fn().mockReturnValue(null),
    getOutputFields: vi.fn().mockReturnValue([]),
    getMcpServersForAgent: vi.fn().mockReturnValue([]),
    getSkillsForAgent: vi.fn().mockReturnValue([])
  }
}

function createMockWindow(overrides: Partial<{
  isDestroyed: boolean
  isVisible: boolean
  isFocused: boolean
}> = {}): any {
  return {
    isDestroyed: vi.fn().mockReturnValue(overrides.isDestroyed ?? false),
    isVisible: vi.fn().mockReturnValue(overrides.isVisible ?? true),
    isFocused: vi.fn().mockReturnValue(overrides.isFocused ?? true),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      send: vi.fn()
    }
  }
}

// Helper to get the last Notification instance created
function getLastNotificationInstance(): any {
  const NotificationMock = Notification as unknown as ReturnType<typeof vi.fn>
  const calls = NotificationMock.mock.instances
  return calls[calls.length - 1]
}

describe('AgentManager idle notifications', () => {
  let agentManager: AgentManager
  let mockDb: any

  beforeEach(() => {
    vi.clearAllMocks()

    // Reset Notification mock to use constructor function
    const NotificationMock = Notification as unknown as ReturnType<typeof vi.fn>
    NotificationMock.mockImplementation(function(this: any) {
      this.show = vi.fn()
      this.on = vi.fn()
    })
    ;(Notification.isSupported as ReturnType<typeof vi.fn>).mockReturnValue(true)

    mockDb = createMockDb()
    agentManager = new AgentManager(mockDb)
  })

  describe('showIdleNotification (via transitionToIdle)', () => {
    // Access private method for direct testing
    function callShowIdleNotification(
      am: AgentManager,
      session: any,
      task: { id: string; title: string }
    ): void {
      ;(am as any).showIdleNotification(session, task)
    }

    it('shows notification when window is not focused', () => {
      const mockWindow = createMockWindow({ isFocused: false })
      agentManager.setMainWindow(mockWindow)
      agentManager.setSelectedTaskId('task-1')

      const session = { lastAssistantMessage: 'I have completed the implementation.' }
      const task = { id: 'task-1', title: 'Fix login bug' }

      callShowIdleNotification(agentManager, session, task)

      expect(Notification).toHaveBeenCalledWith({
        title: 'Task Ready: Fix login bug',
        body: 'I have completed the implementation.',
        silent: false
      })
      const instance = getLastNotificationInstance()
      expect(instance.show).toHaveBeenCalled()
    })

    it('shows notification when window is not visible (minimized to tray)', () => {
      const mockWindow = createMockWindow({ isVisible: false, isFocused: false })
      agentManager.setMainWindow(mockWindow)

      const session = { lastAssistantMessage: 'Done.' }
      const task = { id: 'task-2', title: 'Update README' }

      callShowIdleNotification(agentManager, session, task)

      expect(Notification).toHaveBeenCalled()
      const instance = getLastNotificationInstance()
      expect(instance.show).toHaveBeenCalled()
    })

    it('shows notification when a different task is selected', () => {
      const mockWindow = createMockWindow({ isFocused: true, isVisible: true })
      agentManager.setMainWindow(mockWindow)
      agentManager.setSelectedTaskId('other-task')

      const session = { lastAssistantMessage: 'Finished refactoring.' }
      const task = { id: 'task-3', title: 'Refactor auth module' }

      callShowIdleNotification(agentManager, session, task)

      expect(Notification).toHaveBeenCalled()
      const instance = getLastNotificationInstance()
      expect(instance.show).toHaveBeenCalled()
    })

    it('does NOT show notification when window is focused and task is selected', () => {
      const mockWindow = createMockWindow({ isFocused: true, isVisible: true })
      agentManager.setMainWindow(mockWindow)
      agentManager.setSelectedTaskId('task-4')

      const session = { lastAssistantMessage: 'All done.' }
      const task = { id: 'task-4', title: 'Active task' }

      callShowIdleNotification(agentManager, session, task)

      expect(Notification).not.toHaveBeenCalledWith(expect.anything())
    })

    it('does NOT show notification when Notification is not supported', () => {
      ;(Notification.isSupported as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const mockWindow = createMockWindow({ isFocused: false })
      agentManager.setMainWindow(mockWindow)

      const session = { lastAssistantMessage: 'Done.' }
      const task = { id: 'task-5', title: 'Some task' }

      callShowIdleNotification(agentManager, session, task)

      const NotificationMock = Notification as unknown as ReturnType<typeof vi.fn>
      expect(NotificationMock.mock.instances).toHaveLength(0)
    })

    it('uses default body when no lastAssistantMessage is available', () => {
      const mockWindow = createMockWindow({ isFocused: false })
      agentManager.setMainWindow(mockWindow)

      const session = {} // no lastAssistantMessage
      const task = { id: 'task-6', title: 'No message task' }

      callShowIdleNotification(agentManager, session, task)

      expect(Notification).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Agent has finished working on this task.'
        })
      )
    })

    it('truncates long notification body to 200 characters', () => {
      const mockWindow = createMockWindow({ isFocused: false })
      agentManager.setMainWindow(mockWindow)

      const longMessage = 'A'.repeat(300)
      const session = { lastAssistantMessage: longMessage }
      const task = { id: 'task-7', title: 'Long message task' }

      callShowIdleNotification(agentManager, session, task)

      const callArgs = (Notification as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(callArgs.body.length).toBeLessThanOrEqual(200)
      expect(callArgs.body).toMatch(/\u2026$/)
    })

    it('truncates long task title in notification', () => {
      const mockWindow = createMockWindow({ isFocused: false })
      agentManager.setMainWindow(mockWindow)

      const longTitle = 'T'.repeat(100)
      const session = { lastAssistantMessage: 'Done.' }
      const task = { id: 'task-8', title: longTitle }

      callShowIdleNotification(agentManager, session, task)

      const callArgs = (Notification as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(callArgs.title.length).toBeLessThanOrEqual('Task Ready: '.length + 60)
      expect(callArgs.title).toContain('...')
    })

    it('strips markdown formatting from notification body', () => {
      const mockWindow = createMockWindow({ isFocused: false })
      agentManager.setMainWindow(mockWindow)

      const session = { lastAssistantMessage: '## **Done** with `refactoring` the _module_' }
      const task = { id: 'task-9', title: 'Markdown test' }

      callShowIdleNotification(agentManager, session, task)

      const callArgs = (Notification as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(callArgs.body).not.toContain('#')
      expect(callArgs.body).not.toContain('**')
      expect(callArgs.body).not.toContain('`')
      expect(callArgs.body).not.toContain('_')
    })

    it('registers click handler that focuses window and navigates to task', () => {
      const mockWindow = createMockWindow({ isFocused: false })
      agentManager.setMainWindow(mockWindow)

      const session = { lastAssistantMessage: 'Done.' }
      const task = { id: 'task-10', title: 'Click test task' }

      callShowIdleNotification(agentManager, session, task)

      const instance = getLastNotificationInstance()

      // Verify click handler was registered
      expect(instance.on).toHaveBeenCalledWith('click', expect.any(Function))

      // Simulate click
      const clickHandler = instance.on.mock.calls.find(
        (call: any[]) => call[0] === 'click'
      )[1]
      clickHandler()

      expect(mockWindow.show).toHaveBeenCalled()
      expect(mockWindow.focus).toHaveBeenCalled()
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('task:navigate', 'task-10')
    })

    it('handles missing mainWindow gracefully', () => {
      // Don't set mainWindow — it stays null
      const session = { lastAssistantMessage: 'Done.' }
      const task = { id: 'task-11', title: 'No window task' }

      // Should not throw
      expect(() => callShowIdleNotification(agentManager, session, task)).not.toThrow()
    })

    it('shows notification when no mainWindow is set (app in background)', () => {
      const session = { lastAssistantMessage: 'Done.' }
      const task = { id: 'task-12', title: 'Background task' }

      callShowIdleNotification(agentManager, session, task)

      expect(Notification).toHaveBeenCalled()
      const instance = getLastNotificationInstance()
      expect(instance.show).toHaveBeenCalled()
    })
  })

  describe('setSelectedTaskId', () => {
    it('updates selectedTaskId', () => {
      agentManager.setSelectedTaskId('task-abc')
      expect((agentManager as any).selectedTaskId).toBe('task-abc')
    })

    it('accepts null to clear selection', () => {
      agentManager.setSelectedTaskId('task-abc')
      agentManager.setSelectedTaskId(null)
      expect((agentManager as any).selectedTaskId).toBeNull()
    })
  })
})
