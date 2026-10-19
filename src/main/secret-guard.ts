/**
 * Second line of defence: a small, fast, backstop check for commands whose
 * sole realistic purpose is dumping the process environment (or a specific
 * secret var) to output. This is NOT the guarantee — fix 1 (scrubbing) and
 * fix 2 (broker-only delivery) are. This exists to stop the obvious cases
 * before the model even sees any output, and it's deliberately small: a
 * shell-parsing arms race here would be a losing one.
 *
 * Shared, in spirit, by claude-code-adapter.ts's PreToolUse hook and
 * opencode-adapter.ts's generated plugin — the plugin runs inside OpenCode's
 * own process as a separate generated JS file, so it can't import this
 * module directly; `buildGuardPluginSource()` emits an equivalent JS
 * function from the exact same rule table, and secret-guard.test.ts runs the
 * same fixtures through both to keep them in sync.
 */

export interface GuardResult {
  blocked: boolean
  reason?: string
}

interface GuardRule {
  name: string
  pattern: RegExp
}

// Each pattern is checked against one ";"/"&&"/"||"/"|"/newline-delimited
// segment of the command, not the whole string — so `cd /tmp && env` is
// still caught, while a command that merely contains the substring "env"
// as part of another word (e.g. `environment.sh`) is not.
//
// `cmdPattern` builds an anchored match for "this IS the command being run
// at the start of the segment" — re-review (P2) found several rules
// matched the word ANYWHERE in the segment, including as plain ARGUMENT
// TEXT to an unrelated command: `grep -r printenv src` or
// `git commit -m "fixed a printenv bug"` would both have tripped the old
// `\bprintenv\b` rule, even though neither one actually RUNS printenv.
// Strips a short, fixed list of transparent wrapper prefixes (`sudo`,
// `exec`, `command`, `nice [-n N]`, `time`, a leading `\`, `VAR=value`
// assignments) before anchoring, so `sudo printenv` and `command env`
// are still caught.
const WRAPPER_PREFIX =
  /^(?:\\|sudo\s+|exec\s+|command\s+|nice\s+(?:-n\s*-?\d+\s+)?|time\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/

function stripWrapperPrefixes(segment: string): string {
  let s = segment
  let prev: string
  do {
    prev = s
    s = s.replace(WRAPPER_PREFIX, '')
  } while (s !== prev)
  return s
}

function cmdPattern(commandRegexSource: string): RegExp {
  return new RegExp(`^${commandRegexSource}`)
}

const RULES: GuardRule[] = [
  // Bare `env`, optionally with flags (incl. `-0`, digits — not just
  // letters, so `env -0` is still caught), and nothing else — a full dump.
  // `env FOO=bar realcmd` (scoping one var to a sub-command) is not a dump
  // and is left alone.
  { name: 'env (environment dump)', pattern: cmdPattern('env(\\s+-[a-zA-Z0-9]+)*\\s*$') },
  { name: 'printenv', pattern: cmdPattern('printenv\\b') },
  // Bare `set`, no arguments — lists every shell variable. `set -e`,
  // `set -o pipefail`, etc. are unrelated and left alone.
  { name: 'set (no args)', pattern: cmdPattern('set\\s*$') },
  // Bare `export`, no arguments — same dump as `export -p`.
  { name: 'export (bare, no args)', pattern: cmdPattern('export\\s*$') },
  // `-p`, or any combined short-flag form that includes `p` (`-xp`, `-px`).
  { name: 'export -p', pattern: cmdPattern('export\\s+-[a-zA-Z]*p[a-zA-Z]*\\b') },
  { name: 'declare/typeset -p', pattern: cmdPattern('(declare|typeset)\\s+-[a-zA-Z]*p[a-zA-Z]*\\b') },
  // `declare -x` with no operand lists every exported var (a dump); with an
  // operand (`declare -x MY_VAR=value`, `declare -x MY_VAR`) it exports/sets
  // instead of printing, so only the bare form is blocked. (The `-xp`/`-px`
  // combined form is already caught by the rule above.)
  { name: 'declare/typeset -x (bare)', pattern: cmdPattern('(declare|typeset)\\s+-x\\s*$') },
  // Bash builtin: lists exported variable NAMES (reconnaissance, even
  // without values).
  { name: 'compgen -e', pattern: cmdPattern('compgen\\s+-e\\b') },
  { name: '/proc/*/environ', pattern: /\/proc\/[^/\s]*\/environ\b/ },
  // `ps e` / `ps eww` (BSD-style "show environment") / `ps -E` (GNU-style).
  // Deliberately narrow — `ps -ef`, `ps aux`, etc. are unaffected.
  { name: 'ps with environment flag', pattern: /\bps\b[^\n]*(^|\s)(e|eww|-E)(\s|$)/ }
]

const SEGMENT_SPLIT = /[;&|\n]+/
// Same as SEGMENT_SPLIT but WITHOUT `|` — used only for the echo/printf
// check below, so a secret piped into another command's stdin
// (`echo "$TOKEN" | gh auth login --with-token`, `printf %s "$TOKEN" |
// docker login --password-stdin`) is judged as one unit instead of being
// split at the pipe into "echo $TOKEN" (which looks like a bare dump in
// isolation) and "gh auth login --with-token" (unrelated on its own).
const CHAIN_SPLIT = /[;&\n]+/

const DENY_MESSAGE =
  "Secrets are injected automatically — you don't need to print them; use $VAR_NAME directly in your command. "

function segmentsOf(command: string): string[] {
  return command.split(SEGMENT_SPLIT).map((s) => stripWrapperPrefixes(s.trim())).filter(Boolean)
}

/**
 * Checks one Bash command against the guard rules, plus (when given) a
 * targeted check for `echo`/`printf` of a specific known secret var name —
 * `$MY_SECRET` or `${MY_SECRET}` on the same segment, UNLESS its output is
 * piped into another command (re-review, P2 — see CHAIN_SPLIT above).
 */
export function checkSecretDumpGuard(command: string, knownSecretVarNames: string[] = []): GuardResult {
  for (const segment of segmentsOf(command)) {
    for (const rule of RULES) {
      if (rule.pattern.test(segment)) {
        return { blocked: true, reason: `${DENY_MESSAGE}Blocked: "${rule.name}" can print every secret at once.` }
      }
    }
  }

  for (const chain of command.split(CHAIN_SPLIT).map((s) => s.trim()).filter(Boolean)) {
    for (const varName of knownSecretVarNames) {
      const echoPattern = new RegExp(`\\b(echo|printf)\\b[^\\n]*\\$\\{?${varName}\\b`)
      const match = echoPattern.exec(chain)
      if (!match) continue
      const restOfChain = chain.slice(match.index + match[0].length)
      if (restOfChain.includes('|')) continue // piped into another command's stdin — not a dump
      return { blocked: true, reason: `${DENY_MESSAGE}Blocked: this would print the value of $${varName}.` }
    }
  }
  return { blocked: false }
}

/**
 * Blocks reading the shared secret-loader script's own source (not its
 * output). `tokenFilePath`, re-review: this file holds the session's broker
 * capability token in the clear (see secret-broker.ts's
 * `writeSecretTokenFile`) — reading it directly would hand the model the
 * token, which it could then use to call the broker's `/secrets/export`
 * itself, bypassing this whole guard (and the loader) entirely. Guarded
 * the same way as reading the loader script's own source.
 */
export function checkLoaderReadGuard(
  command: string,
  loaderPath: string | undefined,
  tokenFilePath?: string
): GuardResult {
  const readers = /\b(cat|less|more|head|tail|vi|vim|nano|emacs|xxd|od|strings|type|bat)\b/
  for (const segment of segmentsOf(command)) {
    if (!readers.test(segment)) continue
    if (loaderPath && segment.includes(loaderPath)) {
      return { blocked: true, reason: `${DENY_MESSAGE}Blocked: reading the secret loader's own source is not permitted.` }
    }
    if (tokenFilePath && segment.includes(tokenFilePath)) {
      return { blocked: true, reason: `${DENY_MESSAGE}Blocked: reading the broker token file is not permitted.` }
    }
  }
  return { blocked: false }
}

/**
 * Emits a JS function source, generated from the SAME intent as the rules
 * above, for embedding in opencode-adapter.ts's generated plugin (which runs
 * in OpenCode's own process — it cannot `import` this module). Takes the
 * command string and returns `{blocked, reason}` with the same shape.
 * secret-guard.test.ts runs this generated function (via `new Function`)
 * against the exact same fixtures as `checkSecretDumpGuard` to keep the two
 * in sync.
 */
export function buildGuardFunctionSource(): string {
  return [
    'function checkSecretDumpGuard(command, knownSecretVarNames, loaderPath, tokenFilePath) {',
    '  var DENY = "Secrets are injected automatically — you don\'t need to print them; use $VAR_NAME directly in your command. ";',
    '  var WRAPPER_PREFIX = /^(?:\\\\|sudo\\s+|exec\\s+|command\\s+|nice\\s+(?:-n\\s*-?\\d+\\s+)?|time\\s+|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)+/;',
    '  function stripWrapperPrefixes(segment) {',
    '    var s = segment, prev;',
    '    do { prev = s; s = s.replace(WRAPPER_PREFIX, ""); } while (s !== prev);',
    '    return s;',
    '  }',
    '  function cmdPattern(src) { return new RegExp("^" + src); }',
    '  var rules = [',
    '    { name: "env (environment dump)", pattern: cmdPattern("env(\\\\s+-[a-zA-Z0-9]+)*\\\\s*$") },',
    '    { name: "printenv", pattern: cmdPattern("printenv\\\\b") },',
    '    { name: "set (no args)", pattern: cmdPattern("set\\\\s*$") },',
    '    { name: "export (bare, no args)", pattern: cmdPattern("export\\\\s*$") },',
    '    { name: "export -p", pattern: cmdPattern("export\\\\s+-[a-zA-Z]*p[a-zA-Z]*\\\\b") },',
    '    { name: "declare/typeset -p", pattern: cmdPattern("(declare|typeset)\\\\s+-[a-zA-Z]*p[a-zA-Z]*\\\\b") },',
    '    { name: "declare/typeset -x (bare)", pattern: cmdPattern("(declare|typeset)\\\\s+-x\\\\s*$") },',
    '    { name: "compgen -e", pattern: cmdPattern("compgen\\\\s+-e\\\\b") },',
    '    { name: "/proc/*/environ", pattern: /\\/proc\\/[^/\\s]*\\/environ\\b/ },',
    '    { name: "ps with environment flag", pattern: /\\bps\\b[^\\n]*(^|\\s)(e|eww|-E)(\\s|$)/ }',
    '  ];',
    '  var readers = /\\b(cat|less|more|head|tail|vi|vim|nano|emacs|xxd|od|strings|type|bat)\\b/;',
    '  var segments = String(command).split(/[;&|\\n]+/).map(function(s) { return stripWrapperPrefixes(s.trim()); }).filter(Boolean);',
    '  for (var i = 0; i < segments.length; i++) {',
    '    var segment = segments[i];',
    '    for (var r = 0; r < rules.length; r++) {',
    '      if (rules[r].pattern.test(segment)) return { blocked: true, reason: DENY + "Blocked: \\"" + rules[r].name + "\\" can print every secret at once." };',
    '    }',
    '    if (readers.test(segment)) {',
    '      if (loaderPath && segment.indexOf(loaderPath) !== -1) {',
    '        return { blocked: true, reason: DENY + "Blocked: reading the secret loader\'s own source is not permitted." };',
    '      }',
    '      if (tokenFilePath && segment.indexOf(tokenFilePath) !== -1) {',
    '        return { blocked: true, reason: DENY + "Blocked: reading the broker token file is not permitted." };',
    '      }',
    '    }',
    '  }',
    '  var chains = String(command).split(/[;&\\n]+/).map(function(s) { return s.trim(); }).filter(Boolean);',
    '  for (var c = 0; c < chains.length; c++) {',
    '    var chain = chains[c];',
    '    for (var v = 0; v < (knownSecretVarNames || []).length; v++) {',
    '      var varName = knownSecretVarNames[v];',
    '      var echoPattern = new RegExp("\\\\b(echo|printf)\\\\b[^\\\\n]*\\\\$\\\\{?" + varName + "\\\\b");',
    '      var match = echoPattern.exec(chain);',
    '      if (!match) continue;',
    '      var restOfChain = chain.slice(match.index + match[0].length);',
    '      if (restOfChain.indexOf("|") !== -1) continue;',
    '      return { blocked: true, reason: DENY + "Blocked: this would print the value of $" + varName + "." };',
    '    }',
    '  }',
    '  return { blocked: false };',
    '}'
  ].join('\n')
}
