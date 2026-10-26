import { execFile } from 'child_process'
import { statfs } from 'fs/promises'

export const SWAP_DISK_LOW_BYTES = 2 * 1024 ** 3
export const SWAP_DISK_RECOVERED_BYTES = 10 * 1024 ** 3
export const SWAP_CHECK_INTERVAL_MS = 5_000
export const SWAP_HEARTBEAT_TIMEOUT_MS = 30_000
const LOG_RETRY_MS = 60_000

export type SwapWatchdogMessage =
  | { type: 'ping' }
  | { type: 'low-disk'; freeBytes: number }
  | { type: 'resumed'; freeBytes: number }

interface RecoveryDependencies {
  now: () => number
  freeBytes: () => Promise<number>
  wasSuspended: (since: number) => Promise<boolean>
  isParent: () => boolean
  resume: () => void
  send: (message: SwapWatchdogMessage) => void
}

/** One probe at a time, and at most one outstanding ping while main is suspended. */
export class MacosSwapRecovery {
  private lastPong: number
  private pingPending = false
  private lowDisk = false
  private suspensionConfirmed = false
  private resumeAttempted = false
  private nextLogCheck = 0
  private recoveredSamples = 0
  private checking = false
  private stopped = false

  constructor(private readonly deps: RecoveryDependencies) {
    this.lastPong = deps.now()
  }

  pong(): void {
    this.lastPong = this.deps.now()
    this.pingPending = false
    this.suspensionConfirmed = false
    this.resumeAttempted = false
    this.nextLogCheck = 0
    this.recoveredSamples = 0
  }

  stop(): void {
    this.stopped = true
  }

  async check(): Promise<void> {
    if (this.stopped || this.checking || !this.deps.isParent()) return
    this.checking = true
    try {
      if (!this.pingPending) {
        this.pingPending = true
        this.deps.send({ type: 'ping' })
      }
      const freeBytes = await this.deps.freeBytes()
      if (this.stopped || !this.deps.isParent()) return
      if (freeBytes < SWAP_DISK_LOW_BYTES && !this.lowDisk) {
        this.lowDisk = true
        this.deps.send({ type: 'low-disk', freeBytes })
      } else if (freeBytes >= SWAP_DISK_RECOVERED_BYTES) {
        this.lowDisk = false
      }

      // A stale heartbeat alone could be a debugger or a long synchronous call.
      // Require a kernel suspension event from THIS unresponsive interval.
      if (this.deps.now() - this.lastPong < SWAP_HEARTBEAT_TIMEOUT_MS || this.resumeAttempted) return
      if (!this.suspensionConfirmed && this.deps.now() >= this.nextLogCheck) {
        const since = this.lastPong
        this.nextLogCheck = this.deps.now() + LOG_RETRY_MS
        const confirmed = await this.deps.wasSuspended(since)
        // Main may have answered while the log query was in flight.
        if (this.stopped || this.lastPong !== since || !this.deps.isParent()) return
        this.suspensionConfirmed = confirmed
      }
      if (!this.suspensionConfirmed) return
      // Re-read after the log query. Never resume into the disk-full condition.
      const available = await this.deps.freeBytes()
      if (this.stopped || !this.deps.isParent() || !this.suspensionConfirmed) return
      this.recoveredSamples = available >= SWAP_DISK_RECOVERED_BYTES ? this.recoveredSamples + 1 : 0
      if (this.recoveredSamples < 2) return
      this.resumeAttempted = true
      this.deps.resume()
      this.deps.send({ type: 'resumed', freeBytes: available })
    } catch (error) {
      // Disk/log inspection can fail during disk pressure. Fail closed and retry;
      // never turn an unavailable probe into permission to resume a process.
      this.recoveredSamples = 0
      console.warn('[SwapWatchdog] Probe failed:', error)
    } finally {
      this.checking = false
    }
  }
}

export function isSwapSuspensionLog(output: string, parentPid: number): boolean {
  return output.split('\n').some((line) =>
    line.includes(`[${parentPid}]`) && /suspending .+ due to swap exhaustion/.test(line)
  )
}

/** `log show --start` accepts a local date, independent of the user's locale. */
function logStartTime(time: number): string {
  const d = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function swapRecoveryDependencies(
  parentPid: number,
  send: RecoveryDependencies['send']
): RecoveryDependencies {
  return {
    now: Date.now,
    async freeBytes() {
      // Swap is on the startup volume, even when workspaces are on another disk.
      const disk = await statfs('/System/Volumes/Data')
      return disk.bavail * disk.bsize
    },
    wasSuspended(since) {
      return new Promise((resolve, reject) => {
        execFile('/usr/bin/log', [
          'show', '--start', logStartTime(since), '--style', 'compact',
          '--predicate', `process == "kernel" AND eventMessage CONTAINS "[${parentPid}]" AND eventMessage CONTAINS "due to swap exhaustion"`
        ], { timeout: 10_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
          if (error) reject(error)
          else resolve(isSwapSuspensionLog(stdout, parentPid))
        })
      })
    },
    // A utility process is owned by main. Do not signal a reused PID after exit.
    isParent: () => process.ppid === parentPid,
    resume: () => process.kill(parentPid, 'SIGCONT'),
    send
  }
}
