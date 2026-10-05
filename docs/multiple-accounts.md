# Multiple subscription accounts

A subscription login of Claude Code or Codex is a **harness instance**. "Claude Code", "Claude Code · Personal", "Codex" and "Codex · Work" are each one. An agent picks an instance in its harness dropdown, the same way it picks a harness.

There is no global "active account" and no account-switch action. A task moves to another account only when its agent is changed in the existing agent dropdown.

## Setting up an account

Settings → Agents → **Accounts**:

1. Choose the harness (Claude Code or Codex), a name, and a home folder such as `~/.codex-work`. The folder must not be the harness's own default home.
2. Run the sign-in command shown for that account, in a terminal. 20x never runs the login itself. Each command is quoted, with a POSIX-shell and a PowerShell variant:
   - Codex: `CODEX_HOME="…" codex login`
   - Claude Code: `CLAUDE_CONFIG_DIR="…" claude /login`
   The folder must be absolute (or start with `~`). It cannot be your home folder, the default home of the harness, or a folder that contains the default home.
3. Rename or remove an account at any time. Agents that used a removed account go back to the default login of their harness. Their sessions keep their ids.

The built-in "Claude Code" and "Codex" instances are not stored. They set no home override, so an existing login (including the macOS Keychain item and `~/.claude.json`) stays where it is. An inherited `CLAUDE_CONFIG_DIR` or `CODEX_HOME` still applies.

## Sharing session history

Moving a task between accounts of the same harness keeps its session, so the conversation is not copied. This works only when the accounts read the same session files.

**Codex.** An account home holds its own `auth.json` and `models_cache.json`. Thread state is linked to the real default home: the `sessions`, `archived_sessions`, `skills`, `prompts` and `sqlite` directories, every root-level `*.sqlite` database (`state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite`, and so on), `AGENTS.md` and `session_index.jsonl`. SQLite places the `-wal` and `-shm` files next to the real database, so the links need no companions.

Two files drift. Codex rewrites `config.toml` and may rewrite `session_index.jsonl` atomically, which replaces a link with a plain file. `config.toml` is copied once when an account is set up, and later changes to the default do not reach the account. Re-linking is not done.

**Claude Code.** An account has its own `CLAUDE_CONFIG_DIR`, so its login (`.credentials.json`, or the Keychain entry for that directory) is separate. The session history is linked to the default config directory: `projects/`, plus `session-env/`, `todos/` and `file-history/` when they exist. Not linked: `settings.json`, `.credentials.json`, and `sessions/`, the live process registry. MCP servers are passed to each session by 20x, so they do not depend on the account's settings.

Two points are not verified against the Claude Code CLI. The list of linked directories was chosen from the layout of a local `~/.claude`, and the session-file location is taken from the adapter's existing lookup of `projects/<encoded workspace>/<session>.jsonl`. Re-check the list when the CLI changes.

Links use a directory junction on Windows and a directory symlink elsewhere. Each account's sharing is checked when it is created or changed, and once at startup. Resuming reads only that record, so it does no filesystem work. A real directory is never replaced by a link. An empty one is replaced. A non-empty one, or a link to some other folder, marks the account as **not sharing history**. The settings screen shows this as "Context is carried over".

## What happens when a task changes agent

| Change | Plan | Result |
| --- | --- | --- |
| Same harness, both accounts share history | native resume | Same session id, resumed under the new account's login. Nothing is copied. |
| Same harness, one account does not share history | handoff | Earlier conversation is carried into the first prompt of a new session. |
| Different harness | handoff | Same as above. |
| Native resume, first prompt rejected as session not found | handoff | Session replaced after the context is carried. The same message is resent once. |

Details of the native case:

- The session id is kept when the agent changes. It is replaced only by a new session, and only after the carried context is in that session's prompt.
- The handoff marker is kept after a native resume. It is removed only when the backend answers the first prompt: assistant output, or an idle state after the turn ran. Starting the turn alone does not count, because Claude Code reports a missing session on its stream after the turn has started.
- A "No conversation found", `INCOMPATIBLE_SESSION_ID`, missing-session-file or "session no longer exists" error before that answer starts a new session with the handoff and the same message. No dialog is shown.
- The transcript shows "Continued on <account>" after a native continue. A handoff shows "Context from … carried over". After a native continue that falls back to a handoff, both notes appear, in that order.

API-key agents never share history. They are not affected by accounts.

## Usage limits per account

Plan limits are read for each account, using that account's home. The bottom usage bar shows one chip per account, for example "Codex · Work 85%" and "Codex · Personal 12%". Settings → Usage shows a card for each account. Accounts have no switch button.

Each token-usage record stores the account it came from. Summaries are still grouped by harness.

The triage `usage_limits` value for an agent uses the limits of that agent's account, so agents on different accounts of one harness can be compared for headroom.

Mobile shows account labels as read-only text, in the usage section and in the agent menu of a task.

## Limits of this design

- Only Codex and Claude Code have accounts. Other harnesses use one login each.
- Sessions that run under an account keep running while it is changed. Removing an account does not stop them.
- Session sharing for Claude Code depends on the directory list above, which is not verified against the CLI source.
- Windows junctions were exercised with an injected link function, not on a Windows host.
- Token totals are not split by account in the usage summary.
