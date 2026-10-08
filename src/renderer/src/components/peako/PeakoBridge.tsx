import { useEffect, useRef } from 'react'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useMastermindStore } from '@/stores/mastermind-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { selectVoiceReady, useVoiceStore } from '@/stores/voice-store'
import { agentSessionApi, settingsApi } from '@/lib/ipc-client'
import {
  PEAKO_PARTY_MS,
  PEAKO_SESSION_ID,
  agentModelLabel,
  countSessions,
  derivePeakoMood,
  findOpenQuestion,
  peakoTaskGroup,
  toPeakoMessages,
  toPeakoTasks
} from '@/lib/peako-state'
import { PEAKO_SETTING_KEYS, normalizePeakoName, type PeakoMainCommand, type PeakoState } from '@shared/peako'
import { SettingsTab, TaskStatus } from '@/types'

const PUBLISH_DELAY_MS = 150
const BUBBLE_MS = 8000
/** Re-checks the clock-driven moods (sleep, end of a celebration). */
const TICK_MS = 30_000

export const PEAKO_SETTINGS_CHANGED_EVENT = 'peako-settings-changed'

interface PeakoBridgeProps {
  /** Starts or stops a voice conversation with Mastermind without opening the drawer. */
  onToggleVoice: () => void
}

/**
 * Feeds Peako's desktop window from this window's stores and carries out the
 * commands it sends back. Renders nothing.
 *
 * It listens to the stores directly rather than through React, and publishes
 * at most every 150 ms and only when something changed, so a busy transcript
 * does not re-render the app or flood IPC.
 */
export function PeakoBridge({ onToggleVoice }: PeakoBridgeProps) {
  const toggleVoiceRef = useRef(onToggleVoice)
  toggleVoiceRef.current = onToggleVoice

  useEffect(() => {
    const api = window.electronAPI?.peako
    if (!api) return

    let enabled = true
    let name = normalizePeakoName(null)
    let lastPublished = ''
    let timer: number | null = null
    let lastActivityAt = Date.now()
    let activitySignature = ''
    let celebrateUntil = 0
    let bubble: { text: string; until: number } | null = null
    let knownCompleted: Set<string> | null = null
    let knownWaiting = new Set<string>()
    // The task open in Peako's mini chat. Its transcript is bound only while
    // it is open, exactly like a task open in the app.
    let focusedTaskId: string | null = null
    let releaseFocused: (() => void) | null = null

    const focusTask = (taskId: string | null) => {
      if (taskId === focusedTaskId) return
      releaseFocused?.()
      releaseFocused = null
      focusedTaskId = taskId && useTaskStore.getState().tasks.some((task) => task.id === taskId) ? taskId : null
      if (focusedTaskId) releaseFocused = useAgentStore.getState().bindTranscript(focusedTaskId)
      schedule()
    }

    const say = (text: string) => {
      bubble = { text, until: Date.now() + BUBBLE_MS }
      lastActivityAt = Date.now()
      window.setTimeout(schedule, BUBBLE_MS + 50)
    }

    const taskTitle = (taskId: string) =>
      useTaskStore.getState().tasks.find((task) => task.id === taskId)?.title ?? 'A task'

    const buildTaskChat = (agentNames: Map<string, string>): PeakoState['taskChat'] => {
      if (!focusedTaskId) return null
      const task = useTaskStore.getState().tasks.find((candidate) => candidate.id === focusedTaskId)
      if (!task) return null
      const session = useAgentStore.getState().sessions.get(task.id)
      return {
        id: task.id,
        title: task.title.trim() || 'Untitled task',
        group: peakoTaskGroup(task, session) ?? 'next',
        agentName: task.agent_id ? (agentNames.get(task.agent_id) ?? null) : null,
        hasAgent: Boolean(task.agent_id),
        working: session?.status === SessionStatus.WORKING || Boolean(session?.pendingSend),
        messages: toPeakoMessages(session?.messages ?? []),
        approval: session?.pendingApproval
          ? { action: session.pendingApproval.action, description: session.pendingApproval.description }
          : null
      }
    }

    const buildState = (): PeakoState => {
      const now = Date.now()
      const sessions = useAgentStore.getState().sessions
      const agentNames = new Map(useAgentStore.getState().agents.map((agent) => [agent.id, agent.name]))
      const mastermind = sessions.get(PEAKO_SESSION_ID)
      const voice = useVoiceStore.getState()
      const { agents, selectedAgentId } = useMastermindStore.getState()
      const counts = countSessions(sessions.values())

      const approval = mastermind?.pendingApproval
        ? { action: mastermind.pendingApproval.action, description: mastermind.pendingApproval.description }
        : null
      const thinking = Boolean(mastermind?.pendingSend) || mastermind?.status === SessionStatus.WORKING
      const listening = Boolean(voice.turnId)

      const signature = `${counts.working}/${counts.waiting}/${counts.failed}/${mastermind?.messages.length ?? 0}/${thinking}/${listening}/${voice.speaking}`
      if (signature !== activitySignature) {
        activitySignature = signature
        lastActivityAt = now
      }
      if (bubble && bubble.until <= now) bubble = null

      return {
        name,
        mood: derivePeakoMood({
          listening,
          speaking: voice.speaking,
          thinking,
          waiting: counts.waiting + (approval ? 1 : 0),
          working: counts.working,
          failed: counts.failed,
          celebrating: celebrateUntil > now,
          idleForMs: now - lastActivityAt
        }),
        agents: agents.map((agent) => ({ id: agent.id, name: agent.name, model: agentModelLabel(agent.config) })),
        agentId: selectedAgentId,
        agentLocked: (mastermind?.messages.length ?? 0) > 0,
        status: approval ? 'waiting_approval' : ((mastermind?.status as PeakoState['status']) ?? 'idle'),
        messages: toPeakoMessages(mastermind?.messages ?? []),
        approval,
        voice: {
          available: selectVoiceReady(voice),
          listening,
          speaking: voice.speaking,
          partial: listening ? voice.partial : ''
        },
        counts,
        bubble: bubble?.text ?? null,
        tasks: toPeakoTasks(useTaskStore.getState().tasks, sessions, agentNames),
        taskChat: buildTaskChat(agentNames)
      }
    }

    const publish = () => {
      timer = null
      if (!enabled) return
      const state = buildState()
      const serialized = JSON.stringify(state)
      if (serialized === lastPublished) return
      lastPublished = serialized
      api.publishState(state)
    }

    const schedule = () => {
      if (!enabled || timer !== null) return
      timer = window.setTimeout(publish, PUBLISH_DELAY_MS)
    }

    // Completed tasks are history until a full load has landed; a task event
    // arriving before the first fetch must not make old work look new.
    let sawLoading = useTaskStore.getState().isLoading
    let baselineReady = !sawLoading && useTaskStore.getState().tasks.length > 0

    const watchTasks = () => {
      const { tasks, isLoading } = useTaskStore.getState()
      const completed = new Set(tasks.filter((task) => task.status === TaskStatus.Completed).map((task) => task.id))
      if (!baselineReady) {
        knownCompleted = completed
        if (isLoading) sawLoading = true
        else if (sawLoading) baselineReady = true
        schedule()
        return
      }
      const fresh = knownCompleted && tasks.find((task) => completed.has(task.id) && !knownCompleted!.has(task.id))
      if (fresh) {
        celebrateUntil = Date.now() + PEAKO_PARTY_MS
        say(`Done: ${fresh.title}`)
        window.setTimeout(schedule, PEAKO_PARTY_MS + 50)
      }
      knownCompleted = completed
      schedule()
    }

    const watchSessions = () => {
      const waiting = new Set<string>()
      for (const session of useAgentStore.getState().sessions.values()) {
        if (session.taskId === PEAKO_SESSION_ID) continue
        if (session.pendingApproval || session.status === SessionStatus.WAITING_APPROVAL) waiting.add(session.taskId)
      }
      const fresh = [...waiting].find((taskId) => !knownWaiting.has(taskId))
      if (fresh) say(`${taskTitle(fresh)} needs your OK`)
      knownWaiting = waiting
      schedule()
    }

    const loadName = () =>
      settingsApi
        .get(PEAKO_SETTING_KEYS.name)
        .then((value) => {
          name = normalizePeakoName(value)
          useMastermindStore.getState().setAssistantName(name)
          schedule()
        })
        .catch(() => {})

    /** A message typed in a task's mini chat: an answer if the agent asked something. */
    const sendToTask = async (taskId: string, text: string) => {
      const task = useTaskStore.getState().tasks.find((candidate) => candidate.id === taskId)
      if (!task) return
      if (!task.agent_id) {
        say(`Assign an agent to ${task.title} first`)
        return
      }
      const session = useAgentStore.getState().sessions.get(taskId)
      const question = session?.sessionId ? findOpenQuestion(session.messages) : null
      if (session?.sessionId && question) {
        const responseType = question.tool?.name === 'permission' ? 'permission' : 'question'
        await agentSessionApi.approve(session.sessionId, true, text, responseType, question.tool?.requestId)
        return
      }
      // Main resumes the task's session, or starts one, when none is live.
      await agentSessionApi.sendByTaskId(taskId, text)
    }

    const handleCommand = (command: PeakoMainCommand) => {
      const mastermind = useAgentStore.getState().sessions.get(PEAKO_SESSION_ID)
      switch (command.type) {
        case 'requestState':
          lastPublished = ''
          schedule()
          return
        case 'enabledChanged':
          enabled = command.enabled
          window.dispatchEvent(new CustomEvent(PEAKO_SETTINGS_CHANGED_EVENT))
          if (enabled) schedule()
          return
        case 'send':
          lastActivityAt = Date.now()
          // The drawer's own send path: it starts the session if needed and
          // answers an open question instead of sending a new message.
          void useMastermindStore.getState().send?.(command.text).catch(console.error)
          return
        case 'approve':
          void useMastermindStore.getState().approve?.(command.approved).catch(console.error)
          return
        case 'stop':
          if (mastermind?.sessionId) void agentSessionApi.abort(mastermind.sessionId).catch(console.error)
          return
        case 'voice':
          toggleVoiceRef.current()
          return
        case 'newChat':
          void useMastermindStore.getState().newConversation?.()
          return
        case 'setAgent':
          if (useMastermindStore.getState().agents.some((agent) => agent.id === command.agentId)) {
            void useMastermindStore.getState().changeAgent?.(command.agentId)
          }
          return
        case 'rename':
          name = normalizePeakoName(command.name)
          useMastermindStore.getState().setAssistantName(name)
          window.dispatchEvent(new CustomEvent(PEAKO_SETTINGS_CHANGED_EVENT))
          schedule()
          return
        case 'focusTask':
          focusTask(command.taskId)
          return
        case 'taskSend':
          lastActivityAt = Date.now()
          void sendToTask(command.taskId, command.text).catch((err) => {
            console.error('[peako] message to task failed', err)
            say('That message did not go through')
          })
          return
        case 'taskApprove': {
          const approval = useAgentStore.getState().sessions.get(command.taskId)?.pendingApproval
          if (approval) void agentSessionApi.approve(approval.sessionId, command.approved).catch(console.error)
          return
        }
        case 'taskStop': {
          const sessionId = useAgentStore.getState().sessions.get(command.taskId)?.sessionId
          if (sessionId) void agentSessionApi.abort(sessionId).catch(console.error)
          return
        }
        case 'openTask':
          useUIStore.getState().setSidebarView('tasks')
          useTaskStore.getState().selectTask(command.taskId)
          return
        case 'openSettings':
          useUIStore.getState().setSettingsTab(command.tab === 'voice' ? SettingsTab.VOICE : SettingsTab.GENERAL)
          useUIStore.getState().openSettings()
          return
        default:
          return
      }
    }

    const handleSettingsChanged = () => {
      void loadName()
      void api.getEnabled().then((value) => {
        enabled = value
        if (enabled) {
          lastPublished = ''
          schedule()
        }
      })
    }

    void api.getEnabled().then((value) => {
      enabled = value
      schedule()
    })
    void loadName()
    watchTasks()
    watchSessions()

    const unsubscribers = [
      useAgentStore.subscribe(watchSessions),
      useVoiceStore.subscribe(schedule),
      useMastermindStore.subscribe(schedule),
      useTaskStore.subscribe(watchTasks),
      api.onCommand(handleCommand)
    ]
    window.addEventListener(PEAKO_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
    const tick = window.setInterval(schedule, TICK_MS)

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      window.removeEventListener(PEAKO_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
      window.clearInterval(tick)
      if (timer !== null) window.clearTimeout(timer)
      releaseFocused?.()
    }
  }, [])

  return null
}
