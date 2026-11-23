import { computerServiceInstance } from './service-instance'
import {
  isPublishedHarnessVersion,
  normaliseMachines,
  type ConnectVendor,
  type MachineActionResult,
  type MachinesFailure,
  type MachinesResult,
  type RawByoMachine,
  type RawRunner
} from '../../shared/enterprise-runners'

/**
 * The slice of `EnterpriseAuth` this module needs. Kept as an interface so the
 * sibling "run tasks on enterprise runners" work shares this client and tests
 * can pass a fake.
 */
export interface EnterpriseRequester {
  apiRequest(method: string, path: string, body?: unknown): Promise<unknown>
  getApiUrl(): string
  isSignedIn(): Promise<boolean>
  /** Tenant and user ids of the signed-in session (not secrets). */
  getIdentity?(): Promise<{ tenantId: string; userId: string } | null>
}

export class EnterpriseRunnersApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
    this.name = 'EnterpriseRunnersApiError'
  }
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** Map any thrown value to a UI state. 401/session errors mean "sign in". */
export function toFailure(error: unknown): MachinesFailure {
  const message = error instanceof Error ? error.message : String(error)
  const status = statusOf(error)
  if (status === 403) return { kind: 'permission_denied', message }
  if (status === 401 || /sign in again|session expired|not signed in|not authenticated/i.test(message)) {
    return { kind: 'not_signed_in', message: 'Sign in to Peakflo Enterprise to manage machines.' }
  }
  return { kind: 'unavailable', message }
}

export interface HarnessVersionInfo {
  /** `null` until the server publishes a pin. */
  version: string | null
  nodeEngines: string | null
}

export interface ConnectionInfo {
  /** The one-time connection id. This is all the CLI is given. */
  connectionId: string
  expiresAt: string | null
}

/**
 * Machines and runners API. Routes (workflow-api):
 *
 *   GET    /api/onboarding/byo/machines
 *   PATCH  /api/onboarding/byo/machines/:id        { name }
 *   DELETE /api/onboarding/byo/machines/:id
 *   POST   /api/onboarding/byo/machines/:id/update-now
 *   GET    /api/coding-agents/runners
 *   GET    /api/onboarding/byo/harness-version      (public; the server's pin)
 *   POST   /api/onboarding/byo/tokens               (connection id)
 *
 * TODO(server): a first-class `protocolRefused` flag on both list routes. Until
 * then "refused (426)" is read from `update.state === 'refused'` or the runner's
 * unselectable reason.
 */
export class EnterpriseRunnersApi {
  constructor(private readonly requester: EnterpriseRequester) {}

  getApiUrl(): string {
    return this.requester.getApiUrl()
  }

  /** `computer-<scope>` for the signed-in user on this control plane, if it can be computed. */
  async getComputerInstance(): Promise<string | null> {
    try {
      const identity = await this.requester.getIdentity?.()
      if (!identity) return null
      return computerServiceInstance(this.requester.getApiUrl(), identity.tenantId, identity.userId)
    } catch {
      return null
    }
  }

  async getHarnessVersion(): Promise<HarnessVersionInfo> {
    const raw = (await this.requester.apiRequest('GET', '/api/onboarding/byo/harness-version')) as {
      version?: unknown
      nodeEngines?: unknown
    } | null
    return {
      version: isPublishedHarnessVersion(raw?.version) ? raw.version : null,
      nodeEngines: typeof raw?.nodeEngines === 'string' ? raw.nodeEngines : null
    }
  }

  /**
   * Create the connection id with the user's session. The server returns no
   * enrolment token for a computer connection (the browser approval exchanges
   * one directly with the CLI), and this method refuses a response that does.
   */
  async createConnection(vendors: ConnectVendor[], replacesRunnerId?: string): Promise<ConnectionInfo> {
    const raw = (await this.requester.apiRequest('POST', '/api/onboarding/byo/tokens', {
      discover: true,
      allowed_vendor_backends: vendors,
      ...(replacesRunnerId ? { replaces_runner_id: replacesRunnerId } : {})
    })) as { tokenId?: unknown; expiresAt?: unknown; enrolmentToken?: unknown } | null
    if (typeof raw?.tokenId !== 'string') {
      throw new EnterpriseRunnersApiError('The server did not return a connection id.', null)
    }
    // Never carry a secret the CLI does not need. If a server ever returns one,
    // it is dropped here and never stored or passed on.
    return { connectionId: raw.tokenId, expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null }
  }

  async listMachinesRaw(): Promise<RawByoMachine[]> {
    const raw = (await this.requester.apiRequest('GET', '/api/onboarding/byo/machines')) as {
      machines?: RawByoMachine[]
    } | null
    return Array.isArray(raw?.machines) ? raw.machines : []
  }

  async listRunnersRaw(): Promise<RawRunner[]> {
    const raw = (await this.requester.apiRequest('GET', '/api/coding-agents/runners')) as {
      runners?: RawRunner[]
    } | null
    return Array.isArray(raw?.runners) ? raw.runners : []
  }

  /**
   * One snapshot for the table. A failing runners list degrades to the
   * machines list (and the other way round) rather than failing the page; a
   * permission or sign-in problem on both is reported as such.
   */
  async listMachines(hostname?: string | null): Promise<MachinesResult> {
    if (!(await this.requester.isSignedIn())) {
      return { ok: false, error: { kind: 'not_signed_in', message: 'Sign in to Peakflo Enterprise to manage machines.' } }
    }
    const [machines, runners, version, instance] = await Promise.allSettled([
      this.listMachinesRaw(),
      this.listRunnersRaw(),
      this.getHarnessVersion(),
      this.getComputerInstance()
    ])
    if (machines.status === 'rejected' && runners.status === 'rejected') {
      return { ok: false, error: toFailure(machines.reason) }
    }
    const pinned = version.status === 'fulfilled' ? version.value : { version: null, nodeEngines: null }
    return {
      ok: true,
      snapshot: {
        fetchedAt: Date.now(),
        pinnedVersion: pinned.version,
        nodeEngines: pinned.nodeEngines,
        machines: normaliseMachines({
          machines: machines.status === 'fulfilled' ? machines.value : null,
          runners: runners.status === 'fulfilled' ? runners.value : null,
          pinnedVersion: pinned.version,
          hostname,
          computerInstance: instance.status === 'fulfilled' ? instance.value : null
        })
      }
    }
  }

  private async act(method: string, path: string, body?: unknown): Promise<MachineActionResult> {
    try {
      await this.requester.apiRequest(method, path, body)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: toFailure(error) }
    }
  }

  renameMachine(runnerId: string, name: string): Promise<MachineActionResult> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 255) {
      return Promise.resolve({ ok: false, error: { kind: 'unavailable', message: 'Enter a name up to 255 characters.' } })
    }
    return this.act('PATCH', `/api/onboarding/byo/machines/${encodeURIComponent(runnerId)}`, { name: trimmed })
  }

  /** Deregisters. The service keeps running on that computer until uninstalled there. */
  removeMachine(runnerId: string): Promise<MachineActionResult> {
    return this.act('DELETE', `/api/onboarding/byo/machines/${encodeURIComponent(runnerId)}`)
  }

  /** Allowed while the machine is busy; the machine keeps its id and pinned agents. */
  updateMachine(runnerId: string): Promise<MachineActionResult> {
    return this.act('POST', `/api/onboarding/byo/machines/${encodeURIComponent(runnerId)}/update-now`)
  }
}
