import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentSchedulerStore } from './agent-scheduler-store'

beforeEach(() => {
  useAgentSchedulerStore.setState({
    isEnabled: false,
    runningSessionsPerAgent: new Map(),
    queuedTasksPerAgent: new Map()
  })
})

describe('useAgentSchedulerStore', () => {
  describe('Toggle functionality', () => {
    it('toggle switches isEnabled state', () => {
      expect(useAgentSchedulerStore.getState().isEnabled).toBe(false)

      useAgentSchedulerStore.getState().toggle()
      expect(useAgentSchedulerStore.getState().isEnabled).toBe(true)

      useAgentSchedulerStore.getState().toggle()
      expect(useAgentSchedulerStore.getState().isEnabled).toBe(false)
    })

    it('enable sets isEnabled to true', () => {
      useAgentSchedulerStore.getState().enable()
      expect(useAgentSchedulerStore.getState().isEnabled).toBe(true)
    })

    it('disable sets isEnabled to false and clears state', () => {
      // Setup some state
      useAgentSchedulerStore.setState({
        isEnabled: true,
        runningSessionsPerAgent: new Map([['agent-1', 2]]),
        queuedTasksPerAgent: new Map([['agent-1', ['task-1', 'task-2']]])
      })

      useAgentSchedulerStore.getState().disable()

      expect(useAgentSchedulerStore.getState().isEnabled).toBe(false)
      expect(useAgentSchedulerStore.getState().runningSessionsPerAgent.size).toBe(0)
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.size).toBe(0)
    })
  })

  describe('Running count management', () => {
    it('incrementRunningCount increases count for agent', () => {
      useAgentSchedulerStore.getState().incrementRunningCount('agent-1')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(1)

      useAgentSchedulerStore.getState().incrementRunningCount('agent-1')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(2)
    })

    it('decrementRunningCount decreases count for agent', () => {
      useAgentSchedulerStore.setState({
        runningSessionsPerAgent: new Map([['agent-1', 3]])
      })

      useAgentSchedulerStore.getState().decrementRunningCount('agent-1')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(2)

      useAgentSchedulerStore.getState().decrementRunningCount('agent-1')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(1)
    })

    it('decrementRunningCount does not go below zero', () => {
      useAgentSchedulerStore.setState({
        runningSessionsPerAgent: new Map([['agent-1', 0]])
      })

      useAgentSchedulerStore.getState().decrementRunningCount('agent-1')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(0)
    })

    it('getRunningCount returns 0 for unknown agent', () => {
      expect(useAgentSchedulerStore.getState().getRunningCount('unknown')).toBe(0)
    })

    it('handles multiple agents independently', () => {
      useAgentSchedulerStore.getState().incrementRunningCount('agent-1')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-1')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-2')

      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(2)
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-2')).toBe(1)
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-3')).toBe(0)
    })
  })

  describe('Queue management', () => {
    it('addToQueue adds task to agent queue', () => {
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-1')

      const queue = useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-1')
      expect(queue).toEqual(['task-1'])
    })

    it('addToQueue appends tasks in order', () => {
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-1')
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-2')
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-3')

      const queue = useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-1')
      expect(queue).toEqual(['task-1', 'task-2', 'task-3'])
    })

    it('addToQueue prevents duplicate tasks', () => {
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-1')
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-1')

      const queue = useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-1')
      expect(queue).toEqual(['task-1'])
    })

    it('removeFromQueue removes specific task', () => {
      useAgentSchedulerStore.setState({
        queuedTasksPerAgent: new Map([['agent-1', ['task-1', 'task-2', 'task-3']]])
      })

      useAgentSchedulerStore.getState().removeFromQueue('agent-1', 'task-2')

      const queue = useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-1')
      expect(queue).toEqual(['task-1', 'task-3'])
    })

    it('removeFromQueue handles non-existent task gracefully', () => {
      useAgentSchedulerStore.setState({
        queuedTasksPerAgent: new Map([['agent-1', ['task-1']]])
      })

      useAgentSchedulerStore.getState().removeFromQueue('agent-1', 'task-999')

      const queue = useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-1')
      expect(queue).toEqual(['task-1'])
    })

    it('getNextQueuedTask returns first task in queue', () => {
      useAgentSchedulerStore.setState({
        queuedTasksPerAgent: new Map([['agent-1', ['task-1', 'task-2', 'task-3']]])
      })

      const next = useAgentSchedulerStore.getState().getNextQueuedTask('agent-1')
      expect(next).toBe('task-1')
    })

    it('getNextQueuedTask returns undefined for empty queue', () => {
      const next = useAgentSchedulerStore.getState().getNextQueuedTask('agent-1')
      expect(next).toBeUndefined()
    })

    it('clearQueues removes all queues', () => {
      useAgentSchedulerStore.setState({
        queuedTasksPerAgent: new Map([
          ['agent-1', ['task-1', 'task-2']],
          ['agent-2', ['task-3']]
        ])
      })

      useAgentSchedulerStore.getState().clearQueues()

      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.size).toBe(0)
    })
  })

  describe('Multi-agent scenarios', () => {
    it('manages queues for multiple agents independently', () => {
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-1')
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-2')
      useAgentSchedulerStore.getState().addToQueue('agent-2', 'task-3')
      useAgentSchedulerStore.getState().addToQueue('agent-3', 'task-4')
      useAgentSchedulerStore.getState().addToQueue('agent-3', 'task-5')

      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-1')).toEqual(['task-1', 'task-2'])
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-2')).toEqual(['task-3'])
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-3')).toEqual(['task-4', 'task-5'])
    })

    it('simulates agent-1 with max=2, agent-2 with max=1', () => {
      // Agent 1 starts 2 tasks
      useAgentSchedulerStore.getState().incrementRunningCount('agent-1')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-1')

      // Agent 2 starts 1 task
      useAgentSchedulerStore.getState().incrementRunningCount('agent-2')

      // Add more tasks to queues
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-3')
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-4')
      useAgentSchedulerStore.getState().addToQueue('agent-2', 'task-5')

      // Verify state
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(2)
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-2')).toBe(1)
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-1')).toEqual(['task-3', 'task-4'])
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-2')).toEqual(['task-5'])

      // Simulate agent-1 task completion
      useAgentSchedulerStore.getState().decrementRunningCount('agent-1')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(1)

      // Get next task for agent-1
      const nextTask = useAgentSchedulerStore.getState().getNextQueuedTask('agent-1')
      expect(nextTask).toBe('task-3')

      // Remove from queue and start it
      useAgentSchedulerStore.getState().removeFromQueue('agent-1', 'task-3')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-1')

      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(2)
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-1')).toEqual(['task-4'])
    })

    it('simulates complex multi-agent workflow', () => {
      // Setup: 3 agents with different capacities
      // Agent A: max=3, Agent B: max=2, Agent C: max=1

      // Initial state: all agents start some tasks
      useAgentSchedulerStore.getState().incrementRunningCount('agent-a')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-a')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-a') // Agent A at capacity (3/3)

      useAgentSchedulerStore.getState().incrementRunningCount('agent-b')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-b') // Agent B at capacity (2/2)

      useAgentSchedulerStore.getState().incrementRunningCount('agent-c') // Agent C at capacity (1/1)

      // Queue tasks
      useAgentSchedulerStore.getState().addToQueue('agent-a', 'a-task-4')
      useAgentSchedulerStore.getState().addToQueue('agent-a', 'a-task-5')
      useAgentSchedulerStore.getState().addToQueue('agent-b', 'b-task-3')
      useAgentSchedulerStore.getState().addToQueue('agent-c', 'c-task-2')
      useAgentSchedulerStore.getState().addToQueue('agent-c', 'c-task-3')

      // Verify initial state
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-a')).toBe(3)
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-b')).toBe(2)
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-c')).toBe(1)

      // Agent A completes 1 task
      useAgentSchedulerStore.getState().decrementRunningCount('agent-a')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-a')).toBe(2)
      expect(useAgentSchedulerStore.getState().getNextQueuedTask('agent-a')).toBe('a-task-4')

      // Agent B completes both tasks
      useAgentSchedulerStore.getState().decrementRunningCount('agent-b')
      useAgentSchedulerStore.getState().decrementRunningCount('agent-b')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-b')).toBe(0)
      expect(useAgentSchedulerStore.getState().getNextQueuedTask('agent-b')).toBe('b-task-3')

      // Agent C completes task
      useAgentSchedulerStore.getState().decrementRunningCount('agent-c')
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-c')).toBe(0)
      expect(useAgentSchedulerStore.getState().getNextQueuedTask('agent-c')).toBe('c-task-2')

      // Start next tasks
      useAgentSchedulerStore.getState().removeFromQueue('agent-a', 'a-task-4')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-a')

      useAgentSchedulerStore.getState().removeFromQueue('agent-b', 'b-task-3')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-b')

      useAgentSchedulerStore.getState().removeFromQueue('agent-c', 'c-task-2')
      useAgentSchedulerStore.getState().incrementRunningCount('agent-c')

      // Final state check
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-a')).toBe(3)
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-b')).toBe(1)
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-c')).toBe(1)
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-a')).toEqual(['a-task-5'])
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-b')).toEqual([])
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-c')).toEqual(['c-task-3'])
    })
  })

  describe('Edge cases', () => {
    it('handles operations on non-existent agents gracefully', () => {
      expect(() => {
        useAgentSchedulerStore.getState().incrementRunningCount('ghost-agent')
        useAgentSchedulerStore.getState().decrementRunningCount('ghost-agent')
        useAgentSchedulerStore.getState().addToQueue('ghost-agent', 'task-x')
        useAgentSchedulerStore.getState().removeFromQueue('ghost-agent', 'task-x')
        useAgentSchedulerStore.getState().getNextQueuedTask('ghost-agent')
      }).not.toThrow()
    })

    it('maintains state consistency after disable and re-enable', () => {
      // Setup some state
      useAgentSchedulerStore.getState().enable()
      useAgentSchedulerStore.getState().incrementRunningCount('agent-1')
      useAgentSchedulerStore.getState().addToQueue('agent-1', 'task-1')

      // Disable (clears state)
      useAgentSchedulerStore.getState().disable()
      expect(useAgentSchedulerStore.getState().runningSessionsPerAgent.size).toBe(0)
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.size).toBe(0)

      // Re-enable and add new state
      useAgentSchedulerStore.getState().enable()
      useAgentSchedulerStore.getState().incrementRunningCount('agent-2')
      useAgentSchedulerStore.getState().addToQueue('agent-2', 'task-2')

      expect(useAgentSchedulerStore.getState().getRunningCount('agent-1')).toBe(0)
      expect(useAgentSchedulerStore.getState().getRunningCount('agent-2')).toBe(1)
      expect(useAgentSchedulerStore.getState().queuedTasksPerAgent.get('agent-2')).toEqual(['task-2'])
    })
  })
})
