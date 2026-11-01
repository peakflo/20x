export enum ArtifactType {
  MARKDOWN = 'markdown',
  IMAGE = 'image',
  HTML = 'html',
  PR = 'pr',
  FILE = 'file',
  /** A Spaces workflow. Its `url` is the Spaces summary page (`panelUrl`). */
  WORKFLOW = 'workflow'
}

export enum ArtifactContentKind {
  TEXT = 'text',
  DATA_URL = 'data_url'
}

export enum PullRequestState {
  OPEN = 'open',
  CLOSED = 'closed',
  MERGED = 'merged'
}

export enum PullRequestReviewDecision {
  APPROVED = 'approved',
  CHANGES_REQUESTED = 'changes_requested',
  REVIEW_REQUIRED = 'review_required',
  NONE = 'none'
}

export enum PullRequestCheckState {
  PASSED = 'passed',
  FAILED = 'failed',
  PENDING = 'pending',
  SKIPPED = 'skipped'
}

export interface PullRequestCheck {
  name: string
  state: PullRequestCheckState
  url?: string
}

export interface PullRequestDetails {
  url: string
  repository: string
  number: number
  title: string
  body: string
  state: PullRequestState
  isDraft: boolean
  mergeStateStatus?: string
  reviewDecision: PullRequestReviewDecision
  author: { login: string; avatarUrl?: string; url?: string }
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  changedFiles: number
  commentsCount: number
  reviewsCount: number
  createdAt: string
  updatedAt: string
  mergedAt?: string
  closedAt?: string
  checks: PullRequestCheck[]
}

export interface ArtifactFileEntry {
  path: string
  title: string
  type: ArtifactType
  updatedAt: number
  size: number
  /** Stable logical output identity. Multiple supporting files can belong to
   * one workpiece while `path` points at its selected preview entry file. */
  workpieceKey?: string
  /** All owned files, addressed relative to the task workspace. */
  files?: string[]
  inline?: boolean
  heightHint?: number
}

/** Metadata returned by the explicit artifact/workpiece tools. Files are
 * addressed relative to the artifact, never by an unrestricted workspace
 * path. */
export interface RegisteredArtifact {
  artifactId: string
  taskId: string
  title: string
  type: ArtifactType
  files: string[]
  entryFile?: string
  createdAt: number
  updatedAt: number
  /** Set by `html_render`: shown inline in the chat transcript above the
   * agent's reply, instead of the small open-in-panel card. */
  inline?: boolean
  /** Agent-requested height hint (px) from `html_render`, used to reserve the
   * inline box before the frame reports its real content height. */
  heightHint?: number
}

export interface ArtifactContent {
  kind: ArtifactContentKind
  content: string
  mimeType?: string
}

/** How a "copy the file" request landed on the OS clipboard. Platforms differ
 * in what they accept, so the caller reports the outcome to the user. */
export enum ArtifactClipboardMode {
  /** The file itself is on the clipboard and pastes into a file manager. */
  FILE = 'file',
  /** The file was copied as an image (Windows has no file-list clipboard API). */
  IMAGE = 'image',
  /** Only the file path was copied. */
  PATH = 'path',
  /** The file could not be resolved inside the task workspace. */
  UNAVAILABLE = 'unavailable'
}

export interface ArtifactCopyFileResult {
  mode: ArtifactClipboardMode
}

export interface ArtifactApi {
  scan: (taskId: string) => Promise<ArtifactFileEntry[]>
  read: (taskId: string, relativePath: string) => Promise<ArtifactContent | null>
  saveScad?: (taskId: string, relativePath: string, content: string, expectedContent: string) => Promise<void>
  renderScad?: (taskId: string, relativePath: string) => Promise<string>
  mcpCall?: (input: import('./artifact-mcp').ArtifactMcpCall) => Promise<unknown>
  /** Desktop only. Absent when the viewer runs outside Electron. */
  copyFile?: (taskId: string, relativePath: string) => Promise<ArtifactCopyFileResult>
  /** Desktop only: "Save as…" through a native save dialog. Absent on mobile. */
  saveAs?: (taskId: string, relativePath: string, suggestedName: string) => Promise<boolean>
}

export interface Artifact {
  id: string
  taskId: string
  type: ArtifactType
  title: string
  path?: string
  url?: string
  workpieceKey?: string
  /** All owned files, addressed relative to the task workspace. */
  files?: string[]
  updatedAt: number
  reloadTrigger: number
  /** Set by `html_render`: rendered inline in the chat transcript above the
   * agent's reply, instead of the small open-in-panel card. */
  inline?: boolean
  /** Agent-requested height hint (px) from `html_render`. */
  heightHint?: number
}

/** Registration of a canvas artifact panel with the main-process artifact
 * broker: which artifact it shows and which tasks are edge-connected to it. */
export interface CanvasArtifactPanelRegistration {
  panelId: string
  /** Task that owns the artifact. */
  ownerTaskId: string
  /** Renderer artifact id (stable per task). */
  artifactId: string
  title: string
  type: string
  /** Entry (preview) file, relative to the owner task workspace. */
  path?: string
  /** All owned files, relative to the owner task workspace. */
  files?: string[]
  /** External URL (e.g. PR artifacts). */
  url?: string
  /** Task ids edge-connected to the panel on the canvas (owner excluded). */
  taskIds: string[]
}

export interface ArtifactUIState {
  open: boolean
  activeTabId: string | null
  railExpanded: boolean
}

const PULL_REQUEST_URL_PATTERN = /https?:\/\/[^\s)\]>'"]+\/(?:pull|merge_requests)\/\d+(?:\b|\/)/i
const COMMAND_TOOL_PATTERN = /(?:^|[_:-])(bash|command|exec|shell|terminal)(?:$|[_:-])/

function pullRequestUrlIn(value: unknown): string | undefined {
  if (typeof value === 'string') return value.match(PULL_REQUEST_URL_PATTERN)?.[0]
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = pullRequestUrlIn(item)
      if (url) return url
    }
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const url = pullRequestUrlIn(item)
      if (url) return url
    }
  }
  return undefined
}

/** Extract a PR created/reported by a tool without scraping arbitrary file or
 * transcript content. This prevents documentation examples from becoming
 * bogus artifacts when an agent reads source files. */
export function pullRequestUrlFromTool(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const tool = value as Record<string, unknown>
  const status = typeof tool.status === 'string' ? tool.status.toLowerCase() : ''
  if (!['success', 'succeeded', 'complete', 'completed'].includes(status)) return undefined
  const name = typeof tool.name === 'string' ? tool.name.toLowerCase() : ''
  const output = tool.output

  let parsedOutput: Record<string, unknown> | null = null
  if (output && typeof output === 'object' && !Array.isArray(output)) parsedOutput = output as Record<string, unknown>
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parsedOutput = parsed as Record<string, unknown>
    } catch { /* command output is normally plain text */ }
  }

  for (const key of ['prUrl', 'pr_url', 'pullRequestUrl', 'pull_request_url', 'html_url', 'web_url', 'url']) {
    const candidate = parsedOutput?.[key]
    if (typeof candidate === 'string') {
      const url = candidate.match(PULL_REQUEST_URL_PATTERN)?.[0]
      if (url) return url
    }
  }

  if (name.includes('pull_request') || name.includes('merge_request') || name.includes('create_pr')) {
    return pullRequestUrlIn(output)
  }

  if (!COMMAND_TOOL_PATTERN.test(name)) return undefined
  const text = typeof output === 'string'
    ? output
    : typeof parsedOutput?.stdout === 'string' ? parsedOutput.stdout : ''
  const standalone = text.match(/(?:^|\n)\s*(?:created\s+(?:pull request\s+)?)?(https?:\/\/[^\s)\]>'"]+\/(?:pull|merge_requests)\/\d+(?:\b|\/))\s*(?:\n|$)/i)
  return standalone?.[1]
}

/** Spaces MCP tools that return a workflow summary link as `panelUrl`. */
const WORKFLOW_PANEL_TOOL_PATTERN = /(?:^|[_.:-])workflow_(?:editor_link|test_run|save_version|evidence_report)$/

export interface WorkflowPanelRef {
  url: string
  workflowId: string
  tenantId?: string
}

/**
 * Parse a Spaces workflow summary link.
 *
 * Rule: an absolute http(s) URL with the path `/flow`, a non-empty
 * `workflowId` query value and `view=summary`. Any origin is accepted, because
 * 20x is a desktop app and each Spaces environment (local, stage, production)
 * has its own origin. Other URLs, also other `/flow` views, return undefined.
 */
export function workflowPanelRefFromUrl(href: unknown): WorkflowPanelRef | undefined {
  if (typeof href !== 'string' || !/^https?:\/\//i.test(href.trim())) return undefined
  let url: URL
  try {
    url = new URL(href.trim())
  } catch {
    return undefined
  }
  if (url.pathname.replace(/\/+$/, '') !== '/flow') return undefined
  const workflowId = url.searchParams.get('workflowId')?.trim()
  if (!workflowId || url.searchParams.get('view') !== 'summary') return undefined
  const tenantId = url.searchParams.get('tenantId')?.trim() || undefined
  // Keep the original text so the transcript card can match it in tool output.
  return { url: href.trim(), workflowId, ...(tenantId ? { tenantId } : {}) }
}

/** Stable artifact id for a workflow: one tab for each workflow in a task. */
export function workflowArtifactId(taskId: string, workflowId: string): string {
  return `${taskId}:${ArtifactType.WORKFLOW}:${encodeURIComponent(workflowId)}`
}

const PANEL_URL_TEXT_PATTERN = /["']?panelUrl["']?\s*[:=]\s*["']?(https?:\/\/[^\s"'<>)\]]+)/i
const WORKFLOW_NAME_KEYS = ['workflowName', 'workflow_name', 'name', 'title']

function workflowPanelIn(value: unknown, depth = 0): { ref: WorkflowPanelRef; name?: string } | undefined {
  if (depth > 6) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const found = workflowPanelIn(JSON.parse(trimmed), depth + 1)
        if (found) return found
      } catch { /* not JSON; try the text pattern */ }
    }
    const ref = workflowPanelRefFromUrl(trimmed.match(PANEL_URL_TEXT_PATTERN)?.[1])
    return ref ? { ref } : undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = workflowPanelIn(item, depth + 1)
      if (found) return found
    }
    return undefined
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const ref = workflowPanelRefFromUrl(record.panelUrl)
    if (ref) {
      const name = WORKFLOW_NAME_KEYS.map((key) => record[key]).find((item): item is string => typeof item === 'string' && !!item.trim())
      const nested = record.workflow && typeof record.workflow === 'object' ? (record.workflow as Record<string, unknown>).name : undefined
      return { ref, name: name?.trim() || (typeof nested === 'string' && nested.trim() ? nested.trim() : undefined) }
    }
    for (const item of Object.values(record)) {
      const found = workflowPanelIn(item, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

/** Extract the Spaces workflow summary link (`panelUrl`) from a completed
 * Spaces workflow tool. Tool names may carry an MCP prefix, for example
 * `mcp__workflo__workflow_test_run`. Other tools never create the artifact. */
export function workflowPanelFromTool(value: unknown): { url: string; workflowId: string; title: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const tool = value as Record<string, unknown>
  const status = typeof tool.status === 'string' ? tool.status.toLowerCase() : ''
  if (!['success', 'succeeded', 'complete', 'completed'].includes(status)) return undefined
  const name = typeof tool.name === 'string' ? tool.name.toLowerCase() : ''
  if (!WORKFLOW_PANEL_TOOL_PATTERN.test(name)) return undefined
  const found = workflowPanelIn(tool.output)
  if (!found) return undefined
  return { url: found.ref.url, workflowId: found.ref.workflowId, title: found.name || 'Workflow' }
}

/** Convenience: only the URL, the same shape as `pullRequestUrlFromTool`. */
export function workflowPanelUrlFromTool(value: unknown): string | undefined {
  return workflowPanelFromTool(value)?.url
}

export interface WorkflowPanelCardRef {
  workflowId: string
  /** The link text: the workflow name the agent wrote. */
  name: string
  /** The URL as written. */
  url: string
}

const MARKDOWN_LINK = /\[([^\]\n]*)\]\(<?([^)\s>]+)>?\)/g
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/

/**
 * Take Spaces workflow summary links out of the agent's Markdown, so the chat
 * can show them as workflow cards and not as text links. The same rules as
 * Spaces `extractWorkflowPanelLinks` (workflow-builder
 * packages/ui/lib/coding-agents/workflow-panel-link.ts), with the 20x link
 * rule (`workflowPanelRefFromUrl`: absolute URL, any origin).
 *
 * - A link alone on its line (also a list item or a bare URL): the line is
 *   removed. The card goes below the text.
 * - A link inside a sentence: the link text stays as plain words. The card
 *   goes below the text.
 * - Code fences and other links do not change.
 *
 * Cards are unique by workflow id, in the order of the text.
 */
export function extractWorkflowPanelLinks(markdown: string): { text: string; links: WorkflowPanelCardRef[] } {
  if (!markdown.includes('view=summary')) return { text: markdown, links: [] }
  const links: WorkflowPanelCardRef[] = []
  const add = (workflowId: string, name: string, url: string) => {
    if (!links.some((link) => link.workflowId === workflowId)) links.push({ workflowId, name: name.trim() || 'Workflow', url })
  }
  let inFence = false
  const out: string[] = []
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const bare = line.trim().replace(LIST_MARKER, '').replace(/^<|>$/g, '')
    const bareRef = /^\S+$/.test(bare) ? workflowPanelRefFromUrl(bare) : undefined
    if (bareRef) {
      add(bareRef.workflowId, 'Workflow', bareRef.url)
      continue
    }
    let matchedAny = false
    const replaced = line.replace(MARKDOWN_LINK, (whole, label: string, href: string) => {
      const ref = workflowPanelRefFromUrl(href)
      if (!ref) return whole
      matchedAny = true
      add(ref.workflowId, label, ref.url)
      return label
    })
    if (!matchedAny) {
      out.push(line)
      continue
    }
    // Only link(s) and punctuation left on the line: drop the line.
    const rest = line
      .replace(MARKDOWN_LINK, (whole, _label: string, href: string) => workflowPanelRefFromUrl(href) ? '' : whole)
      .replace(LIST_MARKER, '')
      .replace(/[\s.:,;·—-]/g, '')
    if (rest === '') continue
    out.push(replaced)
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), links }
}

/** Directories that form an explicit deliverable boundary. Files elsewhere in
 * a repository are code and belong in Changes, not in the artifact picker. */
export const ARTIFACT_OUTPUT_DIRECTORIES: ReadonlySet<string> = new Set([
  'artifacts',
  'deliverables',
  'output',
  'outputs',
  'reports'
])

/**
 * Decide whether a workspace file is a logical user-facing deliverable.
 *
 * This mirrors Cloudflare OS's workpiece boundary: a file is not an artifact
 * merely because it can be previewed. Root preview files are treated as
 * standalone deliverables, while nested files require an explicit output
 * directory. Generic code/text files are allowed only inside that boundary.
 */
export function isArtifactDeliverablePath(path: string, type: ArtifactType): boolean {
  return artifactWorkpieceForPath(path, type) !== null
}

export interface ArtifactWorkpiece {
  key: string
  title: string
  grouped: boolean
}

/** Map an output path to its logical workpiece. A nested output folder is one
 * artifact even when it contains an HTML entry point plus many support files. */
export function artifactWorkpieceForPath(path: string, type: ArtifactType): ArtifactWorkpiece | null {
  const segments = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter(Boolean)
  if (segments.length === 0) return null
  const directorySegments = segments.slice(0, -1)
  const boundaryIndex = directorySegments.findIndex((segment) => ARTIFACT_OUTPUT_DIRECTORIES.has(segment.toLowerCase()))

  if (boundaryIndex >= 0) {
    const groupName = segments[boundaryIndex + 1]
    const hasNamedGroup = boundaryIndex + 1 < segments.length - 1
    if (hasNamedGroup) {
      return {
        key: segments.slice(0, boundaryIndex + 2).join('/'),
        title: groupName,
        grouped: true
      }
    }
    return { key: segments.join('/'), title: segments.at(-1)!, grouped: false }
  }

  if (segments.length === 1 && (type !== ArtifactType.FILE || segments[0].toLowerCase().endsWith('.scad'))) {
    return { key: segments[0], title: segments[0], grouped: false }
  }
  return null
}
