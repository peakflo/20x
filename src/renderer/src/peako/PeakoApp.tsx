import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react'
import {
  PEAKO_DEFAULT_NAME,
  PEAKO_NAME_MAX_LENGTH,
  type PeakoChatMessage,
  type PeakoCommand,
  type PeakoLayout,
  type PeakoState,
  type PeakoTaskChat,
  type PeakoTaskGroup,
  type PeakoTaskItem
} from '@shared/peako'
import { MOOD_LABELS, PeakoFace } from './PeakoFace'

const DRAG_THRESHOLD_PX = 4
const QUICK_ASKS = ["What's going on?", 'What needs me?', 'What is blocked?', 'What finished today?']

const INITIAL_STATE: PeakoState = {
  name: PEAKO_DEFAULT_NAME,
  mood: 'idle',
  agents: [],
  agentId: null,
  agentLocked: false,
  status: 'idle',
  messages: [],
  approval: null,
  voice: { available: false, listening: false, speaking: false, partial: '' },
  counts: { working: 0, waiting: 0, failed: 0 },
  bubble: null,
  tasks: [],
  taskChat: null
}

type PanelTab = 'chat' | 'tasks'

const GROUP_LABELS: Record<PeakoTaskGroup, string> = {
  needs: 'Needs you',
  running: 'Running',
  review: 'Ready for review',
  next: 'Up next'
}

const api = window.peakoAPI!

function send(command: PeakoCommand): void {
  api.command(command)
}

export function PeakoApp() {
  const [state, setState] = useState<PeakoState>(INITIAL_STATE)
  const [layout, setLayout] = useState<PeakoLayout>({ expanded: false, panelSide: 'right', mascotAtTop: false })
  const [renaming, setRenaming] = useState(false)
  // Kept here, not in the panel, so the panel reopens where it was left.
  const [tab, setTab] = useState<PanelTab>('chat')

  useEffect(() => {
    const offState = api.onState(setState)
    const offLayout = api.onLayout(setLayout)
    const offRename = api.onStartRename(() => setRenaming(true))
    api.ready()
    return () => {
      offState()
      offLayout()
      offRename()
    }
  }, [])

  const setExpanded = useCallback((expanded: boolean) => {
    void api.setExpanded(expanded).then(setLayout)
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && layout.expanded && !renaming) setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layout.expanded, renaming, setExpanded])

  const rootClass = [
    'peako-root',
    layout.expanded ? 'is-expanded' : '',
    layout.panelSide === 'left' ? 'panel-left' : 'panel-right',
    layout.mascotAtTop ? 'mascot-top' : 'mascot-bottom'
  ].join(' ')

  return (
    <div className={rootClass}>
      <Mascot state={state} expanded={layout.expanded} onToggle={() => setExpanded(!layout.expanded)} />
      {layout.expanded && (
        <ChatPanel
          state={state}
          renaming={renaming}
          setRenaming={setRenaming}
          tab={tab}
          setTab={setTab}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  )
}

function Mascot({ state, expanded, onToggle }: { state: PeakoState; expanded: boolean; onToggle: () => void }) {
  const drag = useRef<{ pointerX: number; pointerY: number; windowX: number; windowY: number; moved: boolean } | null>(
    null
  )
  const frame = useRef<number | null>(null)
  const pendingMove = useRef<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const flushMove = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const move = pendingMove.current
    pendingMove.current = null
    if (move) api.dragMove(move.x, move.y)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerX: event.screenX,
      pointerY: event.screenY,
      windowX: window.screenX,
      windowY: window.screenY,
      moved: false
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current
    if (!current) return
    const dx = event.screenX - current.pointerX
    const dy = event.screenY - current.pointerY
    if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    if (!current.moved) {
      current.moved = true
      setDragging(true)
    }
    // One move per frame keeps IPC calm while following the pointer.
    pendingMove.current = { x: current.windowX + dx, y: current.windowY + dy }
    if (frame.current === null) frame.current = requestAnimationFrame(flushMove)
  }

  const onPointerUp = () => {
    const current = drag.current
    drag.current = null
    if (!current) return
    if (current.moved) {
      setDragging(false)
      // The last move must land before main settles and saves the position.
      flushMove()
      api.dragEnd()
    } else {
      onToggle()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onToggle()
    }
  }

  const badge = state.mood === 'needs' ? '!' : state.counts.waiting > 0 ? String(state.counts.waiting) : null
  const label = `${state.name}: ${MOOD_LABELS[state.mood]}. ${expanded ? 'Click to close the chat' : 'Click to chat'}, drag to move, right-click for more.`

  return (
    <div className="peako-mascot-zone">
      {!expanded && state.bubble && (
        <button type="button" className="peako-bubble" onClick={onToggle}>
          {state.bubble}
        </button>
      )}
      <button
        type="button"
        className={`peako-mascot mood-${state.mood}${dragging ? ' is-dragging' : ''}`}
        aria-label={label}
        title={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault()
          api.contextMenu()
        }}
      >
        <span className="peako-shadow" />
        <span className="peako-bob">
          <PeakoFace mood={state.mood} />
        </span>
        {badge && <span className="peako-badge">{badge}</span>}
        {(state.mood === 'working' || state.mood === 'thinking') && (
          <span className="peako-dots">
            <i />
            <i />
            <i />
          </span>
        )}
        {state.mood === 'sleep' && (
          <span className="peako-zzz">
            <i>z</i>
            <i>z</i>
            <i>z</i>
          </span>
        )}
        {state.mood === 'party' && <Confetti />}
      </button>
    </div>
  )
}

function Confetti() {
  return (
    <span className="peako-confetti" aria-hidden="true">
      {Array.from({ length: 14 }, (_, i) => (
        <i
          key={i}
          style={{
            ['--dx' as string]: `${Math.round(Math.cos((i / 14) * Math.PI * 2) * 60)}px`,
            ['--dy' as string]: `${Math.round(Math.sin((i / 14) * Math.PI * 2) * 45 - 30)}px`,
            ['--rot' as string]: `${i * 53}deg`,
            animationDelay: `${(i % 4) * 0.05}s`
          }}
        />
      ))}
    </span>
  )
}

interface ChatPanelProps {
  state: PeakoState
  renaming: boolean
  setRenaming: (renaming: boolean) => void
  tab: PanelTab
  setTab: (tab: PanelTab) => void
  onClose: () => void
}

function ChatPanel({ state, renaming, setRenaming, tab, setTab, onClose }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const busy = state.status === 'working'
  const needsYou = state.tasks.filter((task) => task.group === 'needs').length

  useEffect(() => {
    if (!renaming && tab === 'chat') inputRef.current?.focus()
  }, [renaming, tab])

  useLayoutEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [state.messages, state.approval, state.voice.partial])

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    send({ type: 'send', text: trimmed })
    setDraft('')
  }

  const onInputKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit(draft)
    }
  }

  const selectedAgent = state.agents.find((agent) => agent.id === state.agentId)

  const tabs = (
    <div className="peako-tabs" role="tablist" aria-label="Show">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'chat'}
        className="peako-tab"
        onClick={() => setTab('chat')}
      >
        Chat
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'tasks'}
        className="peako-tab"
        onClick={() => setTab('tasks')}
      >
        Tasks
        {needsYou > 0 ? (
          <span className="peako-tab-count warn">{needsYou}</span>
        ) : (
          state.tasks.length > 0 && <span className="peako-tab-count">{state.tasks.length}</span>
        )}
      </button>
    </div>
  )

  return (
    <section className="peako-panel" aria-label={`Chat with ${state.name}`}>
      <header className="peako-head">
        <div className="peako-head-main">
          {renaming ? (
            <RenameField
              name={state.name}
              onDone={(name) => {
                if (name !== null) send({ type: 'rename', name })
                setRenaming(false)
              }}
            />
          ) : (
            <button type="button" className="peako-name" title="Rename" onClick={() => setRenaming(true)}>
              {state.name}
              <PencilIcon />
            </button>
          )}
          <div className="peako-sub">
            <span className={`peako-dot status-${state.mood}`} />
            {MOOD_LABELS[state.mood]}
            {state.counts.working > 0 && <span className="peako-meta">· {state.counts.working} working</span>}
            {state.counts.waiting > 0 && <span className="peako-meta warn">· {state.counts.waiting} waiting</span>}
          </div>
        </div>
        <div className="peako-head-actions">
          <IconButton label="New conversation" onClick={() => send({ type: 'newChat' })}>
            <PlusIcon />
          </IconButton>
          <IconButton label="Open 20x" onClick={() => send({ type: 'openApp' })}>
            <ExpandIcon />
          </IconButton>
          <IconButton label="Close chat" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
      </header>

      {tabs}

      {tab === 'tasks' ? (
        <TasksTab state={state} />
      ) : (
        <>
          <div className="peako-brain">
            <label htmlFor="peako-agent">Brain</label>
            <select
              id="peako-agent"
              value={state.agentId ?? ''}
              disabled={state.agentLocked || state.agents.length === 0}
              title={state.agentLocked ? 'Start a new conversation to switch' : 'The agent and model Peako thinks with'}
              onChange={(event) => send({ type: 'setAgent', agentId: event.target.value })}
            >
              {state.agents.length === 0 && <option value="">No agents yet</option>}
              {state.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.model ? `${agent.name} · ${agent.model}` : agent.name}
                </option>
              ))}
            </select>
            {!selectedAgent?.model && state.agents.length > 0 && (
              <button type="button" className="peako-link" onClick={() => send({ type: 'openSettings' })}>
                Set model
              </button>
            )}
          </div>

          <div className="peako-log" ref={logRef} aria-live="polite">
            {state.messages.length === 0 ? (
              <div className="peako-empty">
                <p>
                  Hi, I'm {state.name}. I can see your tasks and agents, start work, and answer questions about any of
                  it.
                </p>
                <div className="peako-chips">
                  {QUICK_ASKS.map((ask) => (
                    <button key={ask} type="button" className="peako-chip" onClick={() => submit(ask)}>
                      {ask}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <MessageList messages={state.messages} onAnswer={submit} />
            )}

            {state.approval && (
              <div className="peako-approval" role="alert">
                <strong>
                  {state.name} wants to {state.approval.action || 'continue'}
                </strong>
                {state.approval.description && <p>{state.approval.description}</p>}
                <div className="peako-approval-actions">
                  <button
                    type="button"
                    className="peako-btn primary"
                    onClick={() => send({ type: 'approve', approved: true })}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="peako-btn"
                    onClick={() => send({ type: 'approve', approved: false })}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}

            {state.voice.listening && (
              <div className="peako-msg role-user is-partial">{state.voice.partial || 'Listening…'}</div>
            )}
          </div>

          <footer className="peako-compose">
            <textarea
              id="peako-input"
              ref={inputRef}
              rows={1}
              value={draft}
              placeholder={state.voice.listening ? 'Listening…' : `Message ${state.name}`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onInputKey}
              aria-label={`Message ${state.name}`}
            />
            <button
              type="button"
              className={`peako-mic${state.voice.listening ? ' is-on' : ''}${state.voice.speaking ? ' is-speaking' : ''}`}
              aria-pressed={state.voice.listening}
              title={
                state.voice.available
                  ? state.voice.listening
                    ? 'Stop talking'
                    : `Talk to ${state.name}`
                  : 'Turn on voice in Settings → Voice'
              }
              onClick={() =>
                state.voice.available ? send({ type: 'voice' }) : send({ type: 'openSettings', tab: 'voice' })
              }
            >
              <MicIcon />
            </button>
            {busy && !draft.trim() ? (
              <button
                type="button"
                className="peako-send stop"
                title="Stop the answer"
                onClick={() => send({ type: 'stop' })}
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="button"
                className="peako-send"
                title="Send"
                disabled={!draft.trim()}
                onClick={() => submit(draft)}
              >
                <SendIcon />
              </button>
            )}
          </footer>
        </>
      )}
    </section>
  )
}

/** The transcript, with answer chips under a question the agent is still asking. */
function MessageList({ messages, onAnswer }: { messages: PeakoChatMessage[]; onAnswer: (text: string) => void }) {
  const [answeredQuestionId, setAnsweredQuestionId] = useState<string | null>(null)
  const lastMessage = messages[messages.length - 1]
  const openQuestion = lastMessage?.role === 'question' && lastMessage.id !== answeredQuestionId ? lastMessage : null
  return (
    <>
      {messages.map((message) => (
        <div key={message.id} className={`peako-msg role-${message.role}`}>
          {message.role === 'tool' ? <span className="peako-tool">{message.text}</span> : message.text}
        </div>
      ))}
      {openQuestion?.options && openQuestion.options.length > 0 && (
        <div className="peako-chips">
          {openQuestion.options.map((option) => (
            <button
              key={option}
              type="button"
              className="peako-chip"
              onClick={() => {
                setAnsweredQuestionId(openQuestion.id)
                onAnswer(option)
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Browse tasks without opening 20x, and talk to the agent on any of them.
 *
 * The list stays mounted under an open task, so going back lands where the
 * user had scrolled to.
 */
function TasksTab({ state }: { state: PeakoState }) {
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    send({ type: 'focusTask', taskId: openId })
  }, [openId])
  // Closing the panel releases the task's transcript in the main window.
  useEffect(() => () => send({ type: 'focusTask', taskId: null }), [])

  const chat = openId && state.taskChat?.id === openId ? state.taskChat : null
  const opened = openId ? state.tasks.find((task) => task.id === openId) : undefined

  return (
    <div className="peako-tasks">
      <TaskList tasks={state.tasks} hidden={openId !== null} onOpen={setOpenId} />
      {openId && (
        <TaskChat chat={chat} fallbackTitle={opened?.title ?? ''} taskId={openId} onBack={() => setOpenId(null)} />
      )}
    </div>
  )
}

function TaskList({
  tasks,
  hidden,
  onOpen
}: {
  tasks: PeakoTaskItem[]
  hidden: boolean
  onOpen: (taskId: string) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Up and down walk the list, so it can be scrolled through from the keyboard.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.peako-task-row') ?? [])
    if (rows.length === 0) return
    event.preventDefault()
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1)
    rows[index < 0 ? 0 : next].focus()
  }

  if (tasks.length === 0) {
    return (
      <div className="peako-log" hidden={hidden}>
        <div className="peako-empty">
          <p>Nothing open right now. Ask me to create a task, or add one in 20x.</p>
        </div>
      </div>
    )
  }

  let lastGroup: PeakoTaskGroup | null = null
  return (
    <div className="peako-task-list" ref={listRef} hidden={hidden} onKeyDown={onKeyDown}>
      {tasks.map((task) => {
        const heading = task.group !== lastGroup ? GROUP_LABELS[task.group] : null
        lastGroup = task.group
        return (
          <div key={task.id} className="peako-task-item">
            {heading && <div className={`peako-group group-${task.group}`}>{heading}</div>}
            <button type="button" className="peako-task-row" onClick={() => onOpen(task.id)}>
              <span className={`peako-task-dot group-${task.group}`} />
              <span className="peako-task-title">{task.title}</span>
              {task.agentName && <span className="peako-task-agent">{task.agentName}</span>}
            </button>
          </div>
        )
      })}
    </div>
  )
}

interface TaskChatProps {
  chat: PeakoTaskChat | null
  taskId: string
  fallbackTitle: string
  onBack: () => void
}

/** A short chat with the agent on one task: what it said, what it asks, and a reply box. */
function TaskChat({ chat, taskId, fallbackTitle, onBack }: TaskChatProps) {
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const agent = chat?.agentName ?? 'the agent'

  useEffect(() => {
    inputRef.current?.focus()
  }, [taskId])

  useLayoutEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [chat?.messages, chat?.approval])

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    send({ type: 'taskSend', taskId, text: trimmed })
    setDraft('')
  }

  const onInputKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit(draft)
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      onBack()
    }
  }

  return (
    <div className="peako-task-chat">
      <div className="peako-task-head">
        <IconButton label="Back to tasks" onClick={onBack}>
          <BackIcon />
        </IconButton>
        <div className="peako-task-head-main">
          <div className="peako-task-head-title" title={chat?.title ?? fallbackTitle}>
            {chat?.title ?? fallbackTitle}
          </div>
          {chat && (
            <div className="peako-sub">
              <span className={`peako-task-dot group-${chat.group}`} />
              {GROUP_LABELS[chat.group]}
              {chat.agentName && <span className="peako-meta">· {chat.agentName}</span>}
            </div>
          )}
        </div>
        <IconButton label="Open in 20x" onClick={() => send({ type: 'openTask', taskId })}>
          <ExpandIcon />
        </IconButton>
      </div>

      <div className="peako-log" ref={logRef} aria-live="polite">
        {!chat ? (
          <div className="peako-empty">
            <p>Loading…</p>
          </div>
        ) : chat.messages.length === 0 ? (
          <div className="peako-empty">
            <p>
              {chat.hasAgent
                ? `Nothing here yet. Write to ${agent} and it starts on this task.`
                : 'No agent is assigned to this task. Open it in 20x to pick one.'}
            </p>
          </div>
        ) : (
          <MessageList messages={chat.messages} onAnswer={submit} />
        )}

        {chat?.approval && (
          <div className="peako-approval" role="alert">
            <strong>
              {chat.agentName ?? 'The agent'} wants to {chat.approval.action || 'continue'}
            </strong>
            {chat.approval.description && <p>{chat.approval.description}</p>}
            <div className="peako-approval-actions">
              <button
                type="button"
                className="peako-btn primary"
                onClick={() => send({ type: 'taskApprove', taskId, approved: true })}
              >
                Approve
              </button>
              <button
                type="button"
                className="peako-btn"
                onClick={() => send({ type: 'taskApprove', taskId, approved: false })}
              >
                Reject
              </button>
            </div>
          </div>
        )}
      </div>

      <footer className="peako-compose">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          disabled={chat !== null && !chat.hasAgent}
          placeholder={chat && !chat.hasAgent ? 'Assign an agent in 20x first' : `Message ${agent}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKey}
          aria-label={`Message ${agent}`}
        />
        {chat?.working && !draft.trim() ? (
          <button
            type="button"
            className="peako-send stop"
            title="Stop the agent"
            onClick={() => send({ type: 'taskStop', taskId })}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="peako-send"
            title="Send"
            disabled={!draft.trim()}
            onClick={() => submit(draft)}
          >
            <SendIcon />
          </button>
        )}
      </footer>
    </div>
  )
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      id="peako-rename"
      ref={ref}
      className="peako-rename"
      value={value}
      maxLength={PEAKO_NAME_MAX_LENGTH}
      aria-label="Name"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onDone(value)
        if (event.key === 'Escape') {
          event.stopPropagation()
          onDone(null)
        }
      }}
    />
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="peako-icon-btn" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  )
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

const PencilIcon = () => (
  <svg {...iconProps} width={12} height={12}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)
const BackIcon = () => (
  <svg {...iconProps}>
    <path d="M15 18 9 12l6-6" />
  </svg>
)
const PlusIcon = () => (
  <svg {...iconProps}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const ExpandIcon = () => (
  <svg {...iconProps}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
)
const CloseIcon = () => (
  <svg {...iconProps}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)
const MicIcon = () => (
  <svg {...iconProps}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
  </svg>
)
const SendIcon = () => (
  <svg {...iconProps}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" />
  </svg>
)
const StopIcon = () => (
  <svg {...iconProps}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)
