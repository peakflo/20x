/**
 * Authority classification for a child's APPROVAL request (a tool/command the
 * child's harness wants to run) — not to be confused with
 * `shared/system-authority.ts`'s `evaluateAuthorityGate`, which scans
 * free-form English PROSE (a heartbeat monitor's findings) for privileged
 * *intent*. A command string like `git push --force origin main` is not
 * English prose, and the prose-oriented patterns there miss it entirely
 * (verified: none of the seven examples below trip it).
 *
 * This module is default-deny, the opposite of a dangerous-pattern denylist:
 * a shell/network/file-write approval for a child's parent to decide on is
 * allowed ONLY when it matches a narrow, explicit SAFE allowlist (read-only
 * commands, edits inside the workspace, tests and builds inside the
 * workspace). Anything else — recognised as actively dangerous, or simply
 * not recognised at all — requires a human, never just the parent agent.
 */

export interface CommandAuthorityInput {
  toolName?: string | null
  command?: string | null
  /** The free-text question/description — used only as a fallback source of command-like text when `command` itself is empty. */
  questionText?: string | null
  /** Absolute path of the child's workspace, when known — used to tell a workspace-local file write from one that escapes it. */
  workspaceDir?: string | null
}

export interface CommandAuthorityResult {
  requiresHuman: boolean
  categories: string[]
}

/** Specific, named dangerous categories — matched first so the human sees *why*, even though an unmatched command is refused anyway by the default-deny fallback below. */
const DANGEROUS_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: 'git-force-or-destructive', pattern: /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/i },
  { category: 'git-force-or-destructive', pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+(-D|--delete\s+--force))\b/i },
  { category: 'git-force-or-destructive', pattern: /\bgit\s+push\b(?![^\n]*--dry-run)/i },
  { category: 'destructive-filesystem', pattern: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\b/i },
  { category: 'destructive-filesystem', pattern: /\b(drop|truncate)\s+(table|database|schema)\b/i },
  { category: 'infra-apply-or-destroy', pattern: /\b(kubectl|helm)\s+(apply|delete)\b/i },
  { category: 'infra-apply-or-destroy', pattern: /\bterraform\s+(apply|destroy)\b/i },
  { category: 'merge-or-release', pattern: /\bgh\s+(pr\s+merge|release\s+create)\b/i },
  { category: 'merge-or-release', pattern: /\b(git\s+push[^\n]*(main|master)\b)/i },
  { category: 'package-publish', pattern: /\b(npm\s+publish|yarn\s+publish|pnpm\s+publish|twine\s+upload|cargo\s+publish|docker\s+push)\b/i },
  { category: 'external-http-mutation', pattern: /\b(curl|wget|http|httpie)\b[^\n]*(-X\s*(POST|PUT|DELETE|PATCH)|--request[=\s]+(POST|PUT|DELETE|PATCH))/i },
  { category: 'external-http-mutation', pattern: /\b(curl|wget)\b[^\n]*-d\b/i },
  { category: 'payment-operation', pattern: /\b(stripe|paypal|braintree)\.com\b[^\n]*\/(v\d+\/)?(charges|payment_intents|payouts|transfers)\b/i }
]

/**
 * Explicit SAFE allowlist. Matched against `toolName command` as one string.
 * Everything NOT matched here is refused by default (see `classifyCommandAuthority`).
 */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  // Read-only shell commands.
  /^\s*(ls|cat|head|tail|wc|pwd|echo|file|stat|du|tree)\b/i,
  /^\s*(grep|rg|ag|find)\b(?!.*(-delete\b|--delete\b|-exec\b|--exec\b))/i,
  // Read-only / workspace-local git.
  /^\s*git\s+(status|diff|log|show|branch(\s+(-l|--list|-a|--all|-v))?|stash\s+(list|show)?|fetch\b)\b/i,
  /^\s*git\s+(add|commit|checkout\s+-b|switch\s+-c)\b/i,
  // Installs, tests, builds, lint/typecheck — all workspace-local, no network mutation of anything external.
  /^\s*(npm|pnpm|yarn)\s+(install|ci|test|run\s+(test|build|lint|typecheck|tsc))\b/i,
  /^\s*(pytest|go\s+test|cargo\s+(test|build|check)|make\s+(test|build)|tsc\b)/i,
  /^\s*python3?\s+-m\s+pytest\b/i
]

/** Tool names that are in-editor file edits (not raw shell), treated as workspace-local writes unless the path clearly escapes the workspace. */
const FILE_EDIT_TOOL_NAMES = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace_editor', 'str_replace_based_edit_tool'])

/**
 * True when a path argument plainly escapes a workspace directory —
 * home-dir shorthand, `..` traversal, a well-known system path, or (when
 * `workspaceDir` is known) an absolute path that isn't under it. Only
 * genuine absolute-path tokens count — a relative path like `src/main/x.ts`
 * contains slashes too but is never mistaken for one, since the match
 * requires the `/` to start the token (string start or preceded by
 * whitespace), not just appear mid-string.
 */
function pathEscapesWorkspace(text: string, workspaceDir?: string | null): boolean {
  if (/(?:^|\s)~\//.test(text) || /\.\.\//.test(text)) return true
  if (/(?:^|\s)\/(etc|usr|System|Library|private)\//.test(text)) return true
  if (workspaceDir) {
    const absolutePaths = text.match(/(?:^|\s)(\/[^\s'"]+)/g) ?? []
    for (const match of absolutePaths) {
      const p = match.trimStart()
      if (!p.startsWith(workspaceDir)) return true
    }
  }
  return false
}

export function classifyCommandAuthority(input: CommandAuthorityInput): CommandAuthorityResult {
  const toolName = (input.toolName ?? '').trim()
  const command = (input.command ?? '').trim()
  // Dangerous-pattern and safe-allowlist matching both look at the command
  // (and the toolName, for context) — but NOT the toolName as a literal
  // prefix glued onto the command, which would break the safe allowlist's
  // start-anchored patterns for a generic exec-style toolName like "exec" or
  // "bash" (`"exec ls -la"` must still match the `ls` pattern).
  const commandText = command || (input.questionText ?? '').trim()
  const combinedText = [toolName, commandText].filter(Boolean).join(' ').trim()

  if (!combinedText) return { requiresHuman: false, categories: [] }

  const categories: string[] = []
  for (const { category, pattern } of DANGEROUS_PATTERNS) {
    if (pattern.test(combinedText) && !categories.includes(category)) categories.push(category)
  }
  if (categories.length > 0) return { requiresHuman: true, categories }

  // A recognised in-editor file edit, as long as nothing in the text looks
  // like it escapes the workspace — treated as the "edits inside the
  // workspace" item on the safe allowlist.
  if (FILE_EDIT_TOOL_NAMES.has(toolName.toLowerCase())) {
    if (pathEscapesWorkspace(combinedText, input.workspaceDir)) {
      return { requiresHuman: true, categories: ['file-write-outside-workspace'] }
    }
    return { requiresHuman: false, categories: [] }
  }

  const isSafe = SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText))
  if (!isSafe) return { requiresHuman: true, categories: ['unrecognized-command'] }
  if (pathEscapesWorkspace(combinedText, input.workspaceDir)) {
    return { requiresHuman: true, categories: ['file-write-outside-workspace'] }
  }
  return { requiresHuman: false, categories: [] }
}
