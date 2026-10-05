import { session } from 'electron'
import { AGENT_BROWSER_PARTITION } from '../shared/agent-browser-session'

export function getAgentBrowserSession(): Electron.Session {
  return session.fromPartition(AGENT_BROWSER_PARTITION)
}
