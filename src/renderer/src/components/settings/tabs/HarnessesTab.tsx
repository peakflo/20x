import { HarnessInstancesSection } from './HarnessInstancesSection'
import { HarnessesSection } from './HarnessesSection'
import { AcpAgentsSection } from './AcpAgentsSection'

/**
 * Settings → Harnesses: everything about the harness CLIs/accounts agents
 * run on, separate from the "Agents" tab's list of configured agents —
 * subscription accounts, version checks/updates, and ACP registry/local
 * agents.
 */
export function HarnessesTab() {
  return (
    <>
      <HarnessInstancesSection />
      <HarnessesSection />
      <AcpAgentsSection />
    </>
  )
}
