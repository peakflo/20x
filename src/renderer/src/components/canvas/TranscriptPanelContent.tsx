import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { Bot, User, Loader2, AlertCircle, Wrench } from 'lucide-react'

interface TranscriptPanelContentProps {
  taskId: string
}

export function TranscriptPanelContent({ taskId }: TranscriptPanelContentProps) {
  const session = useAgentStore((s) => s.sessions.get(taskId))
  const messages = session?.messages ?? []
  const status = session?.status ?? SessionStatus.IDLE

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/50 text-xs">
        <div className="text-center space-y-1">
          <Bot className="h-5 w-5 mx-auto opacity-40" />
          <div>No active session</div>
          <div className="text-[10px] text-muted-foreground/30">
            Start an agent on the linked task to see transcript
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Status indicator */}
      <div className="flex items-center gap-2 pb-2 mb-2 border-b border-border/20 flex-shrink-0">
        <StatusDot status={status} />
        <span className="text-[10px] text-muted-foreground/60 capitalize">
          {status.replace(/_/g, ' ')}
        </span>
        {messages.length > 0 && (
          <span className="text-[10px] text-muted-foreground/30 ml-auto">
            {messages.length} messages
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1 custom-scrollbar">
        {messages.length === 0 ? (
          <div className="text-center text-muted-foreground/30 text-[11px] py-4">
            Waiting for messages…
          </div>
        ) : (
          messages.slice(-50).map((msg) => (
            <div key={msg.id} className="group">
              <div
                className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                {/* Avatar */}
                <div
                  className={`flex-shrink-0 h-5 w-5 rounded-full flex items-center justify-center ${
                    msg.role === 'user'
                      ? 'bg-blue-500/20'
                      : msg.role === 'system'
                        ? 'bg-yellow-500/20'
                        : 'bg-purple-500/20'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <User className="h-3 w-3 text-blue-400" />
                  ) : msg.role === 'system' ? (
                    <AlertCircle className="h-3 w-3 text-yellow-400" />
                  ) : (
                    <Bot className="h-3 w-3 text-purple-400" />
                  )}
                </div>

                {/* Content */}
                <div
                  className={`flex-1 min-w-0 rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-500/10 text-blue-200'
                      : msg.role === 'system'
                        ? 'bg-yellow-500/5 text-yellow-200/80'
                        : 'bg-[#1c2333] text-gray-300'
                  }`}
                >
                  {msg.tool && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50 mb-1">
                      <Wrench className="h-2.5 w-2.5" />
                      <span>{msg.tool.name}</span>
                      {msg.tool.status && (
                        <span
                          className={`ml-1 ${
                            msg.tool.status === 'error'
                              ? 'text-red-400/60'
                              : 'text-green-400/60'
                          }`}
                        >
                          ({msg.tool.status})
                        </span>
                      )}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words line-clamp-6">
                    {msg.content}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}

        {/* Typing indicator */}
        {status === SessionStatus.WORKING && (
          <div className="flex items-center gap-2 py-1">
            <Loader2 className="h-3 w-3 text-purple-400 animate-spin" />
            <span className="text-[10px] text-muted-foreground/40">
              Agent is working…
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: SessionStatus }) {
  const color =
    status === SessionStatus.WORKING
      ? 'bg-amber-400'
      : status === SessionStatus.ERROR
        ? 'bg-red-400'
        : status === SessionStatus.WAITING_APPROVAL
          ? 'bg-yellow-400'
          : 'bg-gray-500'

  return (
    <span className="relative flex h-2 w-2">
      {status === SessionStatus.WORKING && (
        <span
          className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-50`}
        />
      )}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
    </span>
  )
}
