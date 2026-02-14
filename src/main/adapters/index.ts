/**
 * Coding Agent Adapters
 *
 * Export all adapter implementations and the base interface.
 */

export type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart,
  MessagePayload,
} from './coding-agent-adapter'

export { ClaudeCodeAdapter } from './claude-code-adapter'

// TODO: Extract OpencodeAdapter from AgentManager once ready
// export { OpencodeAdapter } from './opencode-adapter'
