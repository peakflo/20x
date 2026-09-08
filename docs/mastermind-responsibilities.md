# Mastermind responsibilities

This implements the product intent from [orch PR #17](https://github.com/iqrahadian/orch/pull/17) inside 20x. Mastermind is the conversation; existing 20x Tasks, agents, transcripts, and workspaces remain the execution system.

The engineer explicitly chose 20x's lifecycle: fully quitting stops agents and monitoring. Reopening restores saved responsibilities and decisions; interrupted work is reconciled before replacement. Closing the Mastermind drawer does not pause responsibilities.

## User journeys and acceptance

1. Create/select a project in Mastermind. Its agreements, memory, conversation and decisions stay separate from other projects.
2. Ask for one review. A bounded Task carries the exact request, the root remains available, and the result appears individually with evidence.
3. Follow up on that review. The next Task retains its findings and working checkout without copying the report. Ambiguous references require clarification.
4. Teach a Goal. Read the proposed scope, success evidence, allowed work, budgets and stop line. Approve it once. Necessary work and independent verification proceed automatically; agent idle alone never means success.
5. Teach a Routine. Review and run its source trial, inspect the collected sample, then activate it. Unchanged deterministic collection and fixed reminders use no model turns. Changed source content is data, classified once as ignore, notify, question or bounded work. Collection errors remain visible.
6. Answer a question. Each pending decision stays visible until answered. Native permission answers target the exact request; expired callbacks cannot authorize a different request. A question's answer supplies context without expanding operation permissions. Claude tool questions are answered through their live SDK callback, including each question in a multi-question prompt.
7. Correct a fact or preference, inspect its provenance, revise or delete it. Permission is held separately in the approved agreement.
8. Pause a responsibility. No new work starts; existing results and questions still arrive. Take over to revoke automation and work directly. Handback starts a fresh assignment from current files and saved context.
9. Quit and reopen. Existing workers are stopped, unresolved launches stay blocked for review, and no uncertain operation is blindly repeated.
10. Run multiple responsibilities over a working day. Settled workers are released while their output remains available. Independent projects can progress; conflicting work in a project is serialized.
11. Ask Mastermind to complete, close, or delete an exact task. Both All tasks and project conversations can inspect task metadata and request the action directly. Close means mark completed. The desktop confirmation shows the target, source action/outputs, dependent deletions and responsibility cancellation before anything changes.

## Product boundaries

- A Task is one assignment per direct human turn (a clarification renews one bounded step), a Goal authorizes necessary continuation, and a Routine authorizes recurring attention. Related Tasks do not automatically become Goals.
- Project files may be one repository, several repositories, or a non-Git folder. A worker can create an isolated checkout inside the approved project; follow-ups retain the reported checkout.
- Existing provider approval and sandbox controls remain in force. New orchestration tools never accept a model-supplied approval flag. Human agreement changes are available only through desktop IPC; worker tools have server-owned, revocable assignment scopes.
- Sources are learned through conversation. A routine can use a finite command, configured MCP reads, or a collection combining both. MCP connections and authentication remain in the existing 20x MCP settings, with availability controlled by the selected agent's existing tool assignments. There is no Slack/Notion/Git-specific routine type or project-local configuration importer.
- Merge, deployment, production mutation, destructive data operations, secrets and external communication require direct human approval. No source, worker result or remembered preference can enlarge that authority.
- Step budgets include work, source classification, optional collection reasoning, and verification. Deadline and repeated no-progress checks stop additional admission. Pausing does not abandon observation.
- Results record the actual checkout, revision and working-file fingerprint. Large checkouts that exceed the bounded inspection limit require a narrower working checkout; this is reported rather than silently counted as verified.

## Validation record

Implementation validation, regression coverage, and live product evidence are recorded in the PR. Unit tests with a controlled agent prove control-plane behavior, not actual provider execution. No merge or deployment is part of this change.

The native Codex worker/verifier journey passed against a temporary non-Git project through the real HTTP MCP endpoint. Both tasks settled with matching file fingerprints and both runtimes were released. The full regression suite passed with process inspection enabled; focused lifecycle, provider, renderer, and IPC checks cover the final changes. Commands and results are recorded in the PR.

The built desktop app opened with an isolated temporary database. Visual interaction could not be completed because the computer-use service was not approved to access the generic Electron application. Renderer and IPC checks are automated; no manual desktop acceptance or full working-day soak is claimed.

## Configured MCP sources

Configure a connection in the existing MCP settings and assign the required tools to the project's selected agent. Then tell Mastermind what matters, for example:

> Watch this Slack channel, the linked Notion release page, and this repository's CI until the end of today. Tell me about release blockers, with source references. Reading only; ask before any external action.

Mastermind uses `discover_source_tools` to list assigned connections and inspect live tool input schemas. Discovery does not collect source content. Missing connections or authentication are handled through the existing settings. Actual Slack/Notion tool names depend on the configured MCP server; no names or providers are hard-coded.

The proposed source lists the exact operations and arguments. A collection may combine command reads (`git`, `gh`, or another finite program) and MCP reads. Tool descriptions and annotations are untrusted metadata, not permission. The engineer must inspect the operations and confirm their read scope before running the source trial. Tools that explicitly declare write effects are rejected for collection. Credentials stay with the connection; they are not copied into the routine or its discovery response.

For paginated MCP results, the proposal records the cursor argument, result-array and next-cursor JSON pointers, and a maximum page count. It must reach an explicit end within that limit. Missing fields, repeated cursors, authentication failures, tool errors, and oversized or partial reads are failures, never "no change." The comparison can select explicit stable fields (shown in the trial) to avoid volatile polling timestamps. Otherwise the full result is compared. The approved query defines coverage; a bounded recent-results query does not promise an unlimited source history or changes a source no longer exposes.

The collector runs the saved reads without a model. Only a changed snapshot enters classification. Optional `source.reasoning` adds an evidence-extraction assignment before comparison when interpreting a source requires reasoning. It requires a Codex or Claude Code agent, whose native project/shell tools can be disabled; other agents can use deterministic source collection. It is limited to one minute, counts toward the agreement's step budget (including its trial), and must report a stable snapshot. Approved scope, project memory, prior results in the same responsibility lineage, and engineer answers remain available as interpretation context; they do not authorize additional source reads. The source trial shows both the derived snapshot and the actual evidence. Reasoning runs on every check when requested; it does not have a zero-model unchanged guarantee. It cannot add or modify source operations. New reads or scope changes require a revised agreement and trial.

Snapshots and change events are saved together before advancing progress. A failed member of a combined collection prevents that collection from advancing; other independent routines can continue. Connection/account changes and tool-definition changes invalidate the affected read, while normal credential refresh remains in the existing auth path. Routine startup waits for authentication restoration. Each collection owns a bounded MCP session so cancelling it does not terminate ordinary integrations' sessions. Full quit cancels and waits for in-flight collection, stops agents, and leaves interrupted reasoning visibly recoverable on reopening.

### Acceptance checks

- Real stdio and HTTP MCP transports: schema discovery, input validation, paginated content, authentication/session headers, stable snapshots, tool errors, cancellation and local process exit.
- Existing command collectors and mixed command/MCP collections remain supported, including a provider-neutral fixture to prevent accidental vendor coupling.
- Human trial/approval, failed re-trial, connection and account changes, source errors without progress advancement, unchanged checks without model admission, and changed results without repeat notifications.
- Bounded source reasoning: no native tools, budget accounting, evidence-backed trial, questions, interruption/recovery, and no ordinary worker launch from a trial recovery.
- Opt-in native journey: `RUN_RESPONSIBILITY_LIVE=1 pnpm test:run src/main/responsibility-manager.live.test.ts -t 'collects a configured'`. It uses an isolated SQLite database, a temporary MCP source, and the real Codex adapter for classification and collection reasoning. It does not contact Slack or Notion.

Live Slack and Notion acceptance still requires working configured connections and agreed read targets. Controlled transport tests are not evidence of those services' authentication or data coverage. The PR records the executed checks and any remaining live-service validation gaps.

## Task administration

Start a fresh Mastermind conversation/session to load the new tools. Ask “Find the task named X”, then “Mark task <ID> completed” or “Delete task <ID>”. Mastermind uses `inspect_tasks` and `manage_task` itself; workers do not receive these controls. Ambiguous names require clarification. A project conversation cannot manage a task owned by a different project's responsibility; use that project or All tasks.

The desktop confirmation defaults to Cancel. Deletion removes the local task, its cascading subtasks/recurring instances, attachments and transcripts, matching existing task deletion. Working checkouts and saved responsibility agreements/reports remain. Linked source records are retained and may reappear on sync. Owning responsibilities are cancelled before cleanup, including when completing their task manually, so automation cannot replace manually closed work; this is not a claim that their goal was independently verified.

The action blocks new launches, messages and permission answers for affected tasks, waits for admitted operations, then releases task and heartbeat runtimes. Failed release prevents deletion/completion. Changed tasks, outputs, source configuration or pending Workflo commands require review again. Agents and responsibilities may already be stopped if a later check or source action fails. Full quit cancels an unanswered confirmation and waits for a confirmed action to settle.

Completion uses the same source action and outputs as the desktop Complete button. It reports success only after the database reflects source-confirmed completion. Existing Workflo requirements remain: local tasks must be eligible to upload to Workflo first; no offline/local-only completion bypass is added. A pending or rejected source action remains incomplete. A task with a pending Workflo upload or completion cannot be deleted or submitted again through these controls until that command is resolved. No automatic worktree deletion or remote task deletion is added.

Include a local task showing **Agent is working** in the completion test: ask Mastermind to complete it and approve the desktop confirmation. After its agent and heartbeat runtimes stop, its saved session ID and status must not block the Workflo handoff. Session history remains available. Failed runtime release must prevent the upload, and a successful upload alone must not display Completed before Workflo confirms it.

Task-control validation covers real HTTP MCP discovery/calls against an isolated database, root/worker tool access, explicit confirmation, cascade cleanup, stale consent, pending commands, launch/message/permission races, release failures, responsibility cancellation and quit. Human confirmation and source acceptance are controlled in tests; actual desktop clicking and a live Workflo completion are still manual acceptance checks.
