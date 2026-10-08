import { create } from 'zustand'
import type { Agent } from '@/types'
import { PEAKO_DEFAULT_NAME } from '@shared/peako'

/**
 * What the Mastermind drawer shares with Peako's bridge. The drawer stays the
 * one owner of the session; it registers the actions others may ask for.
 */
interface MastermindState {
  /** What the user calls the assistant (default "Peako"); every label uses it. */
  assistantName: string
  setAssistantName: (name: string) => void
  agents: Agent[]
  selectedAgentId: string | null
  changeAgent: ((agentId: string) => Promise<void>) | null
  newConversation: (() => Promise<void>) | null
  /** Sends to Mastermind, starting the session first if needed. */
  send: ((message: string) => Promise<void>) | null
  /** Answers Mastermind's pending permission request. */
  approve: ((approved: boolean) => Promise<void>) | null
  setAgents: (agents: Agent[]) => void
  setSelectedAgentId: (agentId: string | null) => void
  registerActions: (actions: {
    changeAgent: (agentId: string) => Promise<void>
    newConversation: () => Promise<void>
    send: (message: string) => Promise<void>
    approve: (approved: boolean) => Promise<void>
  } | null) => void
}

export const useMastermindStore = create<MastermindState>((set) => ({
  assistantName: PEAKO_DEFAULT_NAME,
  setAssistantName: (assistantName) => set({ assistantName }),
  agents: [],
  selectedAgentId: null,
  changeAgent: null,
  newConversation: null,
  send: null,
  approve: null,
  setAgents: (agents) => set({ agents }),
  setSelectedAgentId: (selectedAgentId) => set({ selectedAgentId }),
  registerActions: (actions) =>
    set({
      changeAgent: actions?.changeAgent ?? null,
      newConversation: actions?.newConversation ?? null,
      send: actions?.send ?? null,
      approve: actions?.approve ?? null
    })
}))
