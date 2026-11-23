import {
  redactSecrets,
  type ConnectFailure,
  type ConnectStepId,
  type ConnectStepState
} from '../../shared/enterprise-runners'

export type ConnectEvent =
  | { type: 'line'; text: string; stream: 'stdout' | 'stderr' }
  | { type: 'step'; id: ConnectStepId; state: ConnectStepState }
  /** The raw approval URL. Main-process only: it carries one-time parameters. */
  | { type: 'approve-url'; url: string }
  | { type: 'machine'; name: string }
  | { type: 'company'; name: string }
  | { type: 'harness-added'; name: string }
  | { type: 'success' }
  | { type: 'error-line'; text: string }

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const URL_RE = /https?:\/\/[^\s"'<>]+\/connect-computer\?[^\s"'<>]+/
const ALL_STEPS: ConnectStepId[] = ['connection', 'approve', 'register', 'service']

export function cleanLine(raw: string): string {
  return raw.replace(ANSI, '').replace(CONTROL, '').trimEnd()
}

/**
 * Turn the CLI's text output into structured events. The CLI prints
 * human-readable lines (no machine-readable mode yet), so this matches the
 * stable markers it uses (`✓`, `!`, `✗`) and a few phrases.
 *
 * TODO(harness): ask for `--json` progress output so this does not depend on
 * wording. Until then anything unrecognised is still shown (redacted).
 */
export class ConnectOutputParser {
  private buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  /** After a `✗` line, everything that follows is part of the error (install/sign-in help). */
  private inError = false

  feed(stream: 'stdout' | 'stderr', chunk: string): ConnectEvent[] {
    const events: ConnectEvent[] = []
    const text = this.buffers[stream] + chunk
    const parts = text.split(/\r\n|\n|\r/)
    this.buffers[stream] = parts.pop() ?? ''
    // Bound memory if a process never prints a newline.
    if (this.buffers[stream].length > 8192) this.buffers[stream] = this.buffers[stream].slice(-8192)
    for (const part of parts) events.push(...this.line(stream, part))
    return events
  }

  flush(): ConnectEvent[] {
    const events: ConnectEvent[] = []
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = this.buffers[stream]
      this.buffers[stream] = ''
      if (rest.trim()) events.push(...this.line(stream, rest))
    }
    return events
  }

  private line(stream: 'stdout' | 'stderr', raw: string): ConnectEvent[] {
    const text = cleanLine(raw)
    if (!text.trim()) return []
    const events: ConnectEvent[] = []

    const url = URL_RE.exec(text)
    if (url) events.push({ type: 'approve-url', url: url[0] })

    // Displayed and logged text is always redacted; the raw URL above is not.
    events.push({ type: 'line', text: redactSecrets(text), stream })

    const connecting = /^Connecting .+ on (.+?)…?$/.exec(text)
    if (connecting) {
      events.push({ type: 'machine', name: connecting[1] })
      events.push({ type: 'step', id: 'connection', state: 'done' })
    }
    if (/^Approve this computer in your browser/i.test(text) || url || /^Waiting for approval/i.test(text)) {
      events.push({ type: 'step', id: 'connection', state: 'done' })
      events.push({ type: 'step', id: 'approve', state: 'active' })
    }
    const approved = /^✓ Approved for (.+?)\.?$/.exec(text)
    if (approved) {
      events.push({ type: 'company', name: approved[1] })
      events.push({ type: 'step', id: 'approve', state: 'done' })
      events.push({ type: 'step', id: 'register', state: 'active' })
    }
    if (/^✓ This computer is registered/i.test(text)) {
      events.push({ type: 'step', id: 'approve', state: 'done' })
      events.push({ type: 'step', id: 'register', state: 'done' })
    }
    if (/^Setting up the background service/i.test(text)) {
      events.push({ type: 'step', id: 'register', state: 'done' })
      events.push({ type: 'step', id: 'service', state: 'active' })
    }
    if (/^✓ Background service installed/i.test(text)) {
      events.push({ type: 'step', id: 'service', state: 'done' })
    }
    const added = /^✓ Added (.+?)\.?$/.exec(text)
    if (added) events.push({ type: 'harness-added', name: added[1] })
    if (/^✓ .+ is connected to .+ on .+\. Return to Spaces/.test(text) || /^✓ This computer is already connected to/.test(text)) {
      for (const id of ALL_STEPS) events.push({ type: 'step', id, state: 'done' })
      events.push({ type: 'success' })
    }
    if (/^✗ /.test(text)) this.inError = true
    // Error lines: everything after a `✗`, and stderr (minus npm's warn/notice chatter).
    if (this.inError || (stream === 'stderr' && !/^npm (?:warn|notice|http|info)\b/i.test(text))) {
      events.push({ type: 'error-line', text: redactSecrets(text.replace(/^✗\s*/, '')) })
    }
    return events
  }
}

/**
 * Decide which failure screen to show from the CLI's last error text and exit
 * state. Order matters: the most specific causes first.
 */
export function classifyFailure(input: {
  errorText: string
  exitCode: number | null
  spawnError?: string | null
  platform: NodeJS.Platform
  /** Which step was active when the process ended. */
  activeStep: ConnectStepId | null
  /** Where this connect's service logs (per instance). */
  logPath: string
}): ConnectFailure {
  const text = redactSecrets(input.errorText).trim()
  const spawnError = input.spawnError ?? ''
  const first = text.split('\n')[0]

  if (input.platform !== 'darwin' && input.platform !== 'linux') {
    return { kind: 'unsupported_os', message: 'Runners need macOS or Linux. Use a Mac/Linux machine or a shared runner.' }
  }
  if (/ENOENT|command not found/i.test(spawnError) || /npx: (?:command )?not found/i.test(text)) {
    return {
      kind: 'node_missing',
      message: 'Node.js was not found, so npx cannot run the connect command.',
      help: input.platform === 'darwin' ? 'brew install node' : 'Install Node.js from nodejs.org, then re-check.'
    }
  }
  if (/node(?:\.js)?\b.*(?:version|floor|requires|too old|unsupported)|engine "node"|EBADENGINE/i.test(text)) {
    return {
      kind: 'node_missing',
      message: "This computer's Node.js is too old for the harness.",
      help: input.platform === 'darwin' ? 'brew upgrade node' : 'Install a current Node.js LTS from nodejs.org, then re-check.'
    }
  }
  if (/\bgit\b.*(?:not found|not installed|missing|ENOENT)|spawn git/i.test(text)) {
    return {
      kind: 'git_missing',
      message: 'Git was not found.',
      help: input.platform === 'darwin' ? 'xcode-select --install' : 'Install Git with your package manager, then re-check.'
    }
  }
  if (/timed out waiting for approval|expired|could not be used|get a new (?:command|connection)/i.test(text)) {
    return {
      kind: 'expired',
      message: 'This connection has expired or was already used. Get a new connection and try again.'
    }
  }
  if (/denied|declin|cancel|not approved|rejected/i.test(text)) {
    return { kind: 'denied', message: 'Approval was cancelled. Nothing was installed on this computer.' }
  }
  if (/not installed on this computer|installed but not signed in/i.test(text)) {
    return { kind: 'vendor_missing', message: first || 'The selected harness is not ready on this computer.', help: text }
  }
  if (input.activeStep === 'service' || /service|launchctl|systemctl|bootstrap|launchd/i.test(text)) {
    return { kind: 'service_failed', message: first || 'The background service did not start.', logPath: input.logPath }
  }
  if (input.activeStep === 'approve' && !text) {
    return { kind: 'denied', message: 'Approval was cancelled. Nothing was installed on this computer.' }
  }
  return {
    kind: 'unknown',
    message: first || `The connect command stopped unexpectedly${input.exitCode !== null ? ` (exit ${input.exitCode})` : ''}.`
  }
}

/** Remove one-time parameters from the approval URL before showing it. */
export function sanitiseApproveUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of ['state', 'challenge', 'port']) parsed.searchParams.delete(key)
    return parsed.toString()
  } catch {
    return redactSecrets(url)
  }
}
