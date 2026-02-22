import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Notification, app } from 'electron'
import { exec } from 'child_process'
import { AgentManager } from './agent-manager'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  exec: vi.fn()
}))

const isMacOS = process.platform === 'darwin'

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
        silent: isMacOS // silent on macOS to avoid double sound with osascript
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
      if (isMacOS) {
        expect(exec).not.toHaveBeenCalled()
      }
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

    it('click handler does nothing when window has been destroyed', () => {
      const mockWindow = createMockWindow({ isFocused: false })
      agentManager.setMainWindow(mockWindow)

      const session = { lastAssistantMessage: 'Done.' }
      const task = { id: 'task-13', title: 'Destroyed window test' }

      callShowIdleNotification(agentManager, session, task)

      // Now simulate the window being destroyed before the user clicks
      mockWindow.isDestroyed.mockReturnValue(true)

      const instance = getLastNotificationInstance()
      const clickHandler = instance.on.mock.calls.find(
        (call: any[]) => call[0] === 'click'
      )[1]

      // Should not throw and should not call show/focus/send
      expect(() => clickHandler()).not.toThrow()
      expect(mockWindow.show).not.toHaveBeenCalled()
      expect(mockWindow.focus).not.toHaveBeenCalled()
      expect(mockWindow.webContents.send).not.toHaveBeenCalled()
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

    if (isMacOS) {
      describe('macOS osascript fallback', () => {
        it('calls osascript to display notification on macOS', () => {
          const mockWindow = createMockWindow({ isFocused: false })
          agentManager.setMainWindow(mockWindow)

          const session = { lastAssistantMessage: 'Deployment complete.' }
          const task = { id: 'task-mac-1', title: 'Deploy service' }

          callShowIdleNotification(agentManager, session, task)

          expect(exec).toHaveBeenCalledWith(
            expect.stringContaining('osascript'),
            expect.any(Function)
          )
          const execCall = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
          expect(execCall).toContain('display notification')
          expect(execCall).toContain('Deployment complete.')
          expect(execCall).toContain('Task Ready: Deploy service')
        })

        it('bounces dock icon on macOS', () => {
          const mockWindow = createMockWindow({ isFocused: false })
          agentManager.setMainWindow(mockWindow)

          const session = { lastAssistantMessage: 'Done.' }
          const task = { id: 'task-mac-2', title: 'Dock bounce test' }

          callShowIdleNotification(agentManager, session, task)

          expect(app.dock?.bounce).toHaveBeenCalledWith('informational')
        })

        it('sets Electron Notification silent on macOS to avoid double sound', () => {
          const mockWindow = createMockWindow({ isFocused: false })
          agentManager.setMainWindow(mockWindow)

          const session = { lastAssistantMessage: 'Done.' }
          const task = { id: 'task-mac-3', title: 'Silent test' }

          callShowIdleNotification(agentManager, session, task)

          expect(Notification).toHaveBeenCalledWith(
            expect.objectContaining({ silent: true })
          )
        })

        it('sanitizes quotes in osascript command', () => {
          const mockWindow = createMockWindow({ isFocused: false })
          agentManager.setMainWindow(mockWindow)

          const session = { lastAssistantMessage: 'Fixed the "auth" bug with backslash\\path' }
          const task = { id: 'task-mac-4', title: 'Test with "quotes"' }

          callShowIdleNotification(agentManager, session, task)

          const execCall = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
          // Should not contain unescaped double quotes or backslashes in the osascript body
          const bodyPart = execCall.split("display notification ")[1]
          expect(bodyPart).not.toContain('\\"')
          expect(bodyPart).not.toContain('\\\\')
        })

        it('does NOT call osascript when task is focused and selected', () => {
          const mockWindow = createMockWindow({ isFocused: true, isVisible: true })
          agentManager.setMainWindow(mockWindow)
          agentManager.setSelectedTaskId('task-mac-5')

          const session = { lastAssistantMessage: 'Done.' }
          const task = { id: 'task-mac-5', title: 'Focused task' }

          callShowIdleNotification(agentManager, session, task)

          expect(exec).not.toHaveBeenCalled()
          expect(app.dock?.bounce).not.toHaveBeenCalled()
        })
      })
    }
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
