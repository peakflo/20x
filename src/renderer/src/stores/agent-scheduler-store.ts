import { create } from 'zustand'

interface AgentSchedulerState {
  isEnabled: boolean
  runningSessionsPerAgent: Map<string, number>
  queuedTasksPerAgent: Map<string, string[]>

  toggle: () => void
  enable: () => void
  disable: () => void
  incrementRunningCount: (agentId: string) => void
  decrementRunningCount: (agentId: string) => void
  getRunningCount: (agentId: string) => number
  addToQueue: (agentId: string, taskId: string) => void
  removeFromQueue: (agentId: string, taskId: string) => void
  getNextQueuedTask: (agentId: string) => string | undefined
  clearQueues: () => void
}

export const useAgentSchedulerStore = create<AgentSchedulerState>((set, get) => ({
  isEnabled: false,
  runningSessionsPerAgent: new Map(),
  queuedTasksPerAgent: new Map(),

  toggle: () => set((state) => ({ isEnabled: !state.isEnabled })),

  enable: () => set({ isEnabled: true }),

  disable: () => {
    // Clear all queues when disabling
    set({
      isEnabled: false,
      queuedTasksPerAgent: new Map(),
      runningSessionsPerAgent: new Map()
    })
  },

  incrementRunningCount: (agentId) => {
    set((state) => {
      const newMap = new Map(state.runningSessionsPerAgent)
      newMap.set(agentId, (newMap.get(agentId) || 0) + 1)
      return { runningSessionsPerAgent: newMap }
    })
  },

  decrementRunningCount: (agentId) => {
    set((state) => {
      const newMap = new Map(state.runningSessionsPerAgent)
      const current = newMap.get(agentId) || 0
      if (current > 0) {
        newMap.set(agentId, current - 1)
      }
      return { runningSessionsPerAgent: newMap }
    })
  },

  getRunningCount: (agentId) => {
    return get().runningSessionsPerAgent.get(agentId) || 0
  },

  addToQueue: (agentId, taskId) => {
    set((state) => {
      const newMap = new Map(state.queuedTasksPerAgent)
      const queue = newMap.get(agentId) || []
      if (!queue.includes(taskId)) {
        newMap.set(agentId, [...queue, taskId])
      }
      return { queuedTasksPerAgent: newMap }
    })
  },

  removeFromQueue: (agentId, taskId) => {
    set((state) => {
      const newMap = new Map(state.queuedTasksPerAgent)
      const queue = newMap.get(agentId) || []
      newMap.set(agentId, queue.filter((id) => id !== taskId))
      return { queuedTasksPerAgent: newMap }
    })
  },

  getNextQueuedTask: (agentId) => {
    const queue = get().queuedTasksPerAgent.get(agentId) || []
    return queue[0]
  },

  clearQueues: () => {
    set({ queuedTasksPerAgent: new Map() })
  }
}))
