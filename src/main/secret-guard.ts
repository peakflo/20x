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
const RULES: GuardRule[] = [
  // Bare `env`, optionally with flags, and nothing else — a full dump.
  // `env FOO=bar realcmd` (scoping one var to a sub-command) is not a dump
  // and is left alone.
  { name: 'env (environment dump)', pattern: /^\s*env(\s+-[a-zA-Z]+)*\s*$/ },
  { name: 'printenv', pattern: /\bprintenv\b/ },
  // Bare `set`, no arguments — lists every shell variable. `set -e`,
  // `set -o pipefail`, etc. are unrelated and left alone.
  { name: 'set (no args)', pattern: /^\s*set\s*$/ },
  { name: 'export -p', pattern: /\bexport\s+-p\b/ },
  { name: 'declare/typeset -p', pattern: /\b(declare|typeset)\s+-p\b/ },
  // `declare -x` with no operand lists every exported var (a dump); with an
  // operand (`declare -x MY_VAR=value`, `declare -x MY_VAR`) it exports/sets
  // instead of printing, so only the bare form is blocked.
  { name: 'declare/typeset -x (bare)', pattern: /\b(declare|typeset)\s+-x\s*$/ },
  { name: '/proc/*/environ', pattern: /\/proc\/[^/\s]*\/environ\b/ },
  // `ps e` / `ps eww` (BSD-style "show environment") / `ps -E` (GNU-style).
  // Deliberately narrow — `ps -ef`, `ps aux`, etc. are unaffected.
  { name: 'ps with environment flag', pattern: /\bps\b[^\n]*(^|\s)(e|eww|-E)(\s|$)/ }
]

const SEGMENT_SPLIT = /[;&|\n]+/

const DENY_MESSAGE =
  "Secrets are injected automatically — you don't need to print them; use $VAR_NAME directly in your command. "

function segmentsOf(command: string): string[] {
  return command.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean)
}

/**
 * Checks one Bash command against the guard rules, plus (when given) a
 * targeted check for `echo`/`printf` of a specific known secret var name —
 * `$MY_SECRET` or `${MY_SECRET}` following an echo/printf on the same
 * segment.
 */
export function checkSecretDumpGuard(command: string, knownSecretVarNames: string[] = []): GuardResult {
  for (const segment of segmentsOf(command)) {
    for (const rule of RULES) {
      if (rule.pattern.test(segment)) {
        return { blocked: true, reason: `${DENY_MESSAGE}Blocked: "${rule.name}" can print every secret at once.` }
      }
    }
    for (const varName of knownSecretVarNames) {
      const echoPattern = new RegExp(`\\b(echo|printf)\\b[^\\n]*\\$\\{?${varName}\\b`)
      if (echoPattern.test(segment)) {
        return { blocked: true, reason: `${DENY_MESSAGE}Blocked: this would print the value of $${varName}.` }
      }
    }
  }
  return { blocked: false }
}

/** Blocks reading the shared secret-loader script's own source (not its output). */
export function checkLoaderReadGuard(command: string, loaderPath: string | undefined): GuardResult {
  if (!loaderPath) return { blocked: false }
  const readers = /\b(cat|less|more|head|tail|vi|vim|nano|emacs|xxd|od|strings|type|bat)\b/
  for (const segment of segmentsOf(command)) {
    if (segment.includes(loaderPath) && readers.test(segment)) {
      return { blocked: true, reason: `${DENY_MESSAGE}Blocked: reading the secret loader's own source is not permitted.` }
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
    'function checkSecretDumpGuard(command, knownSecretVarNames, loaderPath) {',
    '  var DENY = "Secrets are injected automatically — you don\'t need to print them; use $VAR_NAME directly in your command. ";',
    '  var segments = String(command).split(/[;&|\\n]+/).map(function(s) { return s.trim(); }).filter(Boolean);',
    '  var rules = [',
    '    { name: "env (environment dump)", pattern: /^\\s*env(\\s+-[a-zA-Z]+)*\\s*$/ },',
    '    { name: "printenv", pattern: /\\bprintenv\\b/ },',
    '    { name: "set (no args)", pattern: /^\\s*set\\s*$/ },',
    '    { name: "export -p", pattern: /\\bexport\\s+-p\\b/ },',
    '    { name: "declare/typeset -p", pattern: /\\b(declare|typeset)\\s+-p\\b/ },',
    '    { name: "declare/typeset -x (bare)", pattern: /\\b(declare|typeset)\\s+-x\\s*$/ },',
    '    { name: "/proc/*/environ", pattern: /\\/proc\\/[^/\\s]*\\/environ\\b/ },',
    '    { name: "ps with environment flag", pattern: /\\bps\\b[^\\n]*(^|\\s)(e|eww|-E)(\\s|$)/ }',
    '  ];',
    '  var readers = /\\b(cat|less|more|head|tail|vi|vim|nano|emacs|xxd|od|strings|type|bat)\\b/;',
    '  for (var i = 0; i < segments.length; i++) {',
    '    var segment = segments[i];',
    '    for (var r = 0; r < rules.length; r++) {',
    '      if (rules[r].pattern.test(segment)) return { blocked: true, reason: DENY + "Blocked: \\"" + rules[r].name + "\\" can print every secret at once." };',
    '    }',
    '    for (var v = 0; v < (knownSecretVarNames || []).length; v++) {',
    '      var varName = knownSecretVarNames[v];',
    '      var echoPattern = new RegExp("\\\\b(echo|printf)\\\\b[^\\\\n]*\\\\$\\\\{?" + varName + "\\\\b");',
    '      if (echoPattern.test(segment)) return { blocked: true, reason: DENY + "Blocked: this would print the value of $" + varName + "." };',
    '    }',
    '    if (loaderPath && segment.indexOf(loaderPath) !== -1 && readers.test(segment)) {',
    '      return { blocked: true, reason: DENY + "Blocked: reading the secret loader\'s own source is not permitted." };',
    '    }',
    '  }',
    '  return { blocked: false };',
    '}'
  ].join('\n')
}
