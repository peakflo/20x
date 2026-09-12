# Mastermind responsibilities

This implements the product intent from [orch PR #17](https://github.com/iqrahadian/orch/pull/17) inside 20x. Mastermind is the conversation; existing 20x Tasks, agents, transcripts, and workspaces remain the execution system.

The engineer explicitly chose 20x's lifecycle: fully quitting stops agents and monitoring. Reopening restores saved responsibilities and decisions; interrupted work is reconciled before replacement. Closing the Mastermind drawer does not pause responsibilities.

## User journeys and acceptance

1. Create/select a project in Mastermind. Its agreements, memory, conversation and decisions stay separate from other projects.
2. Ask for one review. A bounded Task carries the exact request, the root remains available, and the result appears individually with evidence.
3. Follow up on that review. You or Mastermind message the same Task, retaining its conversation and working checkout. New work can reference earlier findings; ambiguous references require clarification.
4. Teach a Goal. Read the proposed scope, success evidence, allowed work, budgets and stop line. Approve it once. Necessary work and independent verification proceed automatically; agent idle alone never means success.
5. Teach a Routine. Review and run its source trial, inspect the collected sample, then activate it. Unchanged deterministic collection and fixed reminders use no model turns. Changed source content is data, classified once as ignore, notify, question or bounded work. Collection errors remain visible.
6. Answer a question. Each relevant pending decision stays visible until answered or made obsolete by confirmed work changes. Native permission answers target the exact request; expired callbacks cannot authorize a different request. A question's answer supplies context without expanding operation permissions. Claude tool questions are answered through their live SDK callback, including each question in a multi-question prompt.
7. Correct a fact or preference, inspect its provenance, revise or delete it. Permission is held separately in the approved agreement.
8. Pause a responsibility. No new work starts; existing results and questions still arrive. You and Mastermind can open and message any saved task directly, without changing automation ownership.
9. Quit and reopen. Existing workers are stopped, unresolved launches stay blocked for review, and no uncertain operation is blindly repeated.
10. Run multiple responsibilities over a working day. Settled workers are released while their output remains available. Independent tasks can progress in the same project.
11. Ask Mastermind to complete, close, or delete an exact task. Both All tasks and project conversations can inspect task metadata and request the action directly. Close means mark completed. The desktop confirmation shows the target, source action/outputs, dependent deletions and responsibility cancellation before anything changes.
12. Resolve a recovery notice. **Review work** opens and focuses its exact agreement and evidence, even when no worker was started. **Open task** links to saved worker context when available. **Ask Mastermind** prepares an editable follow-up in the correct project; it also remains available for expired requests. Reviewing or drafting does not restart automation, revise limits, or mark a notice answered.

13. Keep follow-ups current. Confirmed task deletion/completion, work cancellation/completion, revised agreements and newer work close obsolete requests. Decisions and badges update together; closed cards move to collapsed **History** with the reason and time. Historical task links disappear when the task is deleted. Failed or declined actions do not count as successful deletion/completion; if a partial deletion cancelled the workflow first, its questions close for that confirmed cancellation. Deleting a historical task alone keeps a still-relevant Goal or Routine decision. Ordinary messages and pauses do not dismiss questions. Startup and the existing tick repair old stale cards even when proactive follow-up is paused. Answers and queued notifications are checked again before acting or publishing; uncertain answer delivery stays visible for review.

## Groups

Groups sit above tasks inside **Tasks** and **Canvas**, with no additional sidebar menu. Create an empty Group or select existing tasks, then manage its name, description and membership from the Group. Tasks retain their own agents, conversations, permissions and dependency links. **All tasks** and **Ungrouped** remain available.

Use **Show on Canvas** to open a Group together. Its frame follows the member panels; dragging or closing a panel only changes layout. New members appear in a shown Group, and explicitly closed panels stay closed until the Group is shown again.

Each Factory execution receives a Group unless an existing project Group is selected. Later stages and recurring checks keep that Group. Manual task moves and removals remain in effect, while Factory history retains the original execution relationship. Mastermind can inspect and manage Groups directly, including assigning future stages of a saved execution to an existing Group.

**Delete Group only** keeps tasks and active work; later stages stay Ungrouped. **Delete Group and all tasks** uses one scrollable confirmation showing exact tasks, cascading subtasks/recurring instances and affected automations. Work stops before deletion. A partial failure retains the Group and remaining tasks. Linked remote records follow the existing local task-deletion behavior.

Acceptance: create a Group with existing tasks; create a task inside it; move/remove members; check the same membership in Tasks and Canvas; close a panel and refresh/reopen; add a member while the Group is shown; run multiple Factory stages and recurring checks; delete only the Group while work continues; decline and then confirm a Group-plus-tasks deletion. Verify unrelated tasks and agent defaults remain unchanged.

## Files in Mastermind

Paste or drop local files into the Mastermind message box to insert their original absolute paths. Paths are editable message text and nothing sends automatically. Multiple files stay on separate lines. Pasted clipboard images without an existing path become private PNG files in the OS temporary directory (up to 50 MB each); 20x keeps them after sending or quitting and does not maintain an attachment library for them.

The agent reads referenced files with its existing tools and permissions. A reference points to the current file contents, so moving/deleting a file or OS temporary-file cleanup can make it unavailable. Regular task attachments retain their existing storage behavior. Preparing an image blocks sending until its path is ready, and conversion or startup failures preserve the message draft.

## Shared task conversations

The engineer and Mastermind can both message an existing Mastermind task at any time, using the same conversation. No ownership transfer is required. Messages to a running assignment invalidate its previous completion report until the agent responds to the new input. Follow-up conversation after a saved result does not restart a completed Goal or Routine.

Independent tasks can run in the same project folder. Interrupted assignments no longer reserve the whole workspace. Session creation is still coalesced per task so simultaneous messages do not create duplicate workers; normal permission checks and destructive-action confirmations remain.

## Proactive follow-up

Each project's **Proactive follow-up** is on by default. Use **Pause** or **Continue** below the Mastermind project selector; the button and On / Reviewing / Paused status remain visible when the project details are collapsed. The existing five-second tick notices saved results, questions, failures, meaningful workflow progress and expired deadlines. Mastermind reviews these in its existing project conversation, using the selected conversation agent. Closing the drawer does not stop follow-up.

Updates are short and include task links. A desktop notification opens the right project when the app is unfocused. Work and Decisions retain the underlying evidence and exact approval controls; publishing a summary does not mark a decision answered or its result read. Ordinary clarification replies in Mastermind or the original saved task can be routed to the exact pending question using the latest recorded human message. Saved task conversations receive only context, result reading and this answer control; they cannot create assignments or report new automation results. A matching answer can continue within the existing agreement; paused work stays paused. Ambiguous or unrelated messages do not settle a question. Native questions and permission approvals continue through their original controls, and confirmed responses settle their exact Mastermind card too.

A review handles up to eight events, normally at most once per minute per project. New questions, failures and deadlines can bypass the cooldown. Unchanged source reads use no model turn; fixed reminders publish their existing text directly. After ten minutes with no visible activity, a running task may receive one status question. Silence does not establish failure, and no background loop restarts work or repeatedly chases the same task. A new human instruction can begin a new observation period.

The review can read project context/results, send that bounded status question, and publish its update. It cannot approve requests, create assignments, expand scope, or alter schedules. Review turns have a two-minute limit. The scheduler keeps running while the model responds. Human messages supersede a background review before the human turn is sent; worker task conversations remain directly accessible. Reviewed events and published responses are saved separately, so failure and restart do not silently replay uncertain deliveries. The project control shows an error and explicit Retry when needed.

Turning follow-up off leaves work and schedules under their own controls. Fully quitting stops both work and reviews. On reopening, pending events are reconsidered against current state; already delivered events are not repeated. A review interrupted before delivery stays visible for inspection and explicit retry.

Acceptance: delegate a finite task, leave Mastermind alone, and see a concise result with **Open task**; receive a blocker; answer an ordinary question in the conversation; interrupt a pending review with your own message; pause/resume follow-up without pausing work; quit/reopen without replay; verify quiet tasks receive only one nudge and unchanged routines do not wake a model. `RUN_RESPONSIBILITY_LIVE=1 pnpm test:run src/main/responsibility-manager.live.test.ts -t 'proactively delivers'` exercises real worker completion, automatic delivery, task links, duplicate suppression and direct task reply in an isolated project.

## Product boundaries

The left sidebar's **Automation** page is a read-only overview across all projects. It lists recurring task templates once (including existing separate-task schedules), plus project Goals and Routines, with their saved status, timing, and next step. Paused and completed records remain visible. It refreshes from existing task and responsibility events, independently of task filters or the selected Mastermind project. It adds no schedule controls or execution behavior; changes still happen through Mastermind or existing task controls.

Ask Mastermind to delete an inactive Task, Goal, or Routine proposal. It finds the agreement and requests native confirmation for that exact project, proposal and revision. Confirmed deletion removes it from Work, Automation, and pending decisions while retaining any source-trial tasks, results, files and project memory. Changed proposals, active agreements and unfinished source trials are refused; this control does not cancel running work. Both project Mastermind and All tasks expose it, while workers do not. A new conversation session after updating the app may be needed to discover the tool.

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

Manual **Complete** actions from the Tasks page, canvas, and keyboard shortcuts use the same task administration as Mastermind. The existing desktop confirmation stops local agents and owning automation before handing completion to the source. Saved session history stays available. Declining the confirmation leaves the task alone; failed release or unconfirmed source completion stays visible and does not mark the task completed.

Start a fresh Mastermind conversation/session to load the new tools. Ask “Find the task named X”, then “Mark task <ID> completed” or “Delete task <ID>”. Mastermind uses `inspect_tasks` and `manage_task` itself; workers do not receive these controls. Ambiguous names require clarification. A project conversation cannot manage a task owned by a different project's responsibility; use that project or All tasks.

You can change the Mastermind agent in either All tasks or a project conversation, including after messages have been exchanged. Switching waits for the old conversation session to stop, keeps its transcript, and gives the new agent recent conversation context. The choice is remembered separately for each conversation. Worker assignments and existing routines keep their own configured agents. If the old agent cannot be stopped, the selector keeps the old choice and shows the error.

The desktop confirmation defaults to Cancel. Deletion removes the local task, its cascading subtasks/recurring instances, attachments and transcripts, matching existing task deletion. Working checkouts and saved responsibility agreements/reports remain. Linked source records are retained and may reappear on sync. Owning responsibilities are cancelled before cleanup, including when completing their task manually, so automation cannot replace manually closed work; this is not a claim that their goal was independently verified.

The action blocks new launches, messages and permission answers for affected tasks, waits for admitted operations, then releases task and heartbeat runtimes. Failed release prevents deletion/completion. Changed tasks, outputs, source configuration or pending Workflo commands require review again. Agents and responsibilities may already be stopped if a later check or source action fails. Full quit cancels an unanswered confirmation and waits for a confirmed action to settle.

Completion uses the same source action and outputs as the desktop Complete button. It reports success only after the database reflects source-confirmed completion. Local tasks are first saved as human-owned Workflo records without transferring their local agent, skills, or schedule. A Workflo connection is required, but completing finished work does not require a Workflo agent or synced skills. History and outputs remain; normal uploads for future work retain their agent, skill, and schedule checks. A pending or rejected source action remains incomplete. A task with a pending Workflo upload or completion cannot be deleted or submitted again through these controls until that command is resolved. No automatic worktree deletion or remote task deletion is added.

Include a local task showing **Agent is working** in the completion test: ask Mastermind to complete it and approve the desktop confirmation. After its agent and heartbeat runtimes stop, its saved session ID and status must not block the Workflo handoff. Session history remains available. Failed runtime release must prevent the upload, and a successful upload alone must not display Completed before Workflo confirms it.

Task-control validation covers real HTTP MCP discovery/calls against an isolated database, root/worker tool access, explicit confirmation, cascade cleanup, stale consent, pending commands, launch/message/permission races, release failures, responsibility cancellation and quit. Human confirmation and source acceptance are controlled in tests; actual desktop clicking and a live Workflo completion are still manual acceptance checks.

## Pausing a recurring task schedule

Ask Mastermind to “pause the recurring workflow schedule.” It uses `inspect_tasks` to find the recurring template, then `manage_task` with `pause_schedule`. Confirm the named schedule in the desktop dialog. The template remains in Recurring tasks and shows Paused; its task view also offers Pause schedule / Resume schedule. Schedule controls are available to Mastermind, not worker sessions.

Pause persists across quit/reopen and prevents new instances, including schedule repair. Existing runs continue; the cron, agent, automation settings and history remain. Ask to resume and confirm: the next future occurrence runs, without replaying the paused period. This controls local recurring task templates; project Routine agreements and global auto-run retain their existing separate controls. Workflo schedules must be managed at their source.

To test, pause a five-minute recurring template, leave 20x open across its due time, and verify no new instance appears. Quit/reopen and check it is still paused. Resume, verify the next time is in the future, and verify exactly one new instance at that time. Confirm existing runs and unrelated schedules are retained. Declining confirmation or choosing an individual run must not change its template.

## Reusing a scheduled task

New local recurring tasks default to **Reuse one task**, in the form and through `create_task`. **Create a task each time** keeps the original behavior. Existing schedules keep that original mode after upgrading; they are never silently converted. This changes recurring Tasks only, not project Routine agreements, MCP configuration, global auto-run, or Workflo-owned scheduling.

A reusable schedule keeps one task and workspace, with a fresh agent session for each check. Its Check history records the run time, outcome, transcript and artifact copies. Recent results enter the next check as context, without granting new permission. A finished check leaves the task open. Task auto-completion is unavailable in reuse mode; use Complete when you want to end the schedule, following the normal confirmed Workflo handoff. History remains readable after completion. Deletion pauses scheduling and releases the runtime before deleting the task and its history; working files are retained.

Scheduled and manual starts share the same admission guard. A working check, approval wait or unresolved cleanup blocks another check. Missed times are skipped, without a backlog. With auto-start disabled, due times coalesce into one pending manual check. **Run check** starts a fresh check, including when an earlier result is unread. A settled provider error appears in history and does not block the next scheduled check. An uncertain launch, failed release or interrupted restart pauses scheduling and requires inspection followed by **Release after inspection**. Recovery retains partial history and leaves the schedule paused. Resume schedules the next future occurrence.

To convert an existing schedule, pause it and resolve any unfinished execution first. Ask Mastermind to reuse its exact template (`manage_task`, `reuse_schedule`) and confirm the desktop dialog, or change Execution in its edit form. Conversion retains old task instances and results, disables task auto-completion, and leaves scheduling paused. An unstarted pending check can be discarded when changing modes. `separate_schedule` switches back under the same conditions. Mastermind can inspect recent checks with `inspect_tasks` plus `task_id` and `runs: true`, read one with `run_id`, and request inspected recovery with `recover_schedule`.

Artifact copies are bounded to 200 files and 100 MB per check. Exceeding either limit pauses for inspection; it never silently replaces an older report. Checks retain their workspace files and checkpoints; this is not a filesystem snapshot or a retention policy for arbitrary files outside registered artifacts.

Acceptance: run two checks and confirm one task, the same workspace, distinct sessions and separate history; change an artifact and confirm the earlier copy stays readable. Leave a check working or waiting for approval across a due time and confirm no overlapping run. Disable auto-start across two due times and confirm one pending check. Pause/resume, quit/reopen during work, inspect/release the interrupted check, and complete/delete while working. Source rejection must leave completion unconfirmed and scheduling paused. Existing separate-task schedules must continue creating instances as before. Controlled lifecycle tests do not establish live Slack/Notion authentication or a real Workflo completion.

The native two-check acceptance passed with `RUN_SCHEDULE_LIVE=1 pnpm test:run src/main/schedule-runs.test.ts -t 'two native checks'`: real Codex at medium effort, an isolated database and temporary workspace, one task, two distinct sessions, a checkpoint advancing from 1 to 2, two finished history entries, and both runtimes released. No external source was used.

## Factories

A Factory is a project’s reusable way of conducting work. Open **Factories** in the left navigation to browse its saved diagram and complete instructions. Choose a project and **Create in Mastermind**, or choose **Use** / **Edit in Mastermind** on an existing guide. These actions open the correct project conversation and insert a draft for you to finish and send. There is no required input format or direct diagram editor.

Mastermind proposes the exact name, diagram and instructions. Only **Save this Factory** in the main desktop confirms them; **Discard** saves nothing. A revised draft invalidates the older preview. Each named Factory has one current definition. Ask project Mastermind to delete an exact Factory, then confirm the displayed deletion. Pending proposals and definitions survive reopening. Diagrams use the existing renderer or readable ASCII; they are never parsed into executable workflow nodes.

Your explicit selection wins. Mastermind may otherwise choose a clearly relevant project Factory, and uses ordinary work for weak matches. A single assignment stays a Task. Automatic multi-assignment execution uses an approved Goal, or work within an approved Routine, with a visible scope, deadline, step budget and agent choices. Factory selection does not approve edits or expand authority. Factories and MCP configuration are independent.

Coordination runs as bounded reasoning through the existing responsibility lifecycle. It chooses one necessary task at a time, consumes the same budget, receives saved evidence and the guide, and has no project execution tools. Work uses fresh sessions; returning to the original reviewer is not required. Conditional branches create tasks only when needed. Answers to Factory work questions return to coordination, which chooses the next necessary action without blindly restarting the previous assignment. An independent verification assignment must confirm the finish line before a Factory Goal completes. The project agent is the default; extra existing agents are included in execution approval, and configuration changes require renewed approval. Automatic coordination currently uses Codex or Claude Code, which support disabling native project tools.

Use **Show on canvas** on the execution agreement to see its actual tasks and handoffs. The selected flow updates as work progresses without changing execution or switching views in the background. Existing panels retain their positions. Canvas connections show relationships; removing a connection does not cancel work. Mastermind’s decision/result notices link to **Open task**. You and Mastermind can message that task directly. Replying after its result is saved continues the conversation; only explicitly answering a still-pending workflow question can continue the existing agreement.

Admitted assignments retain their Factory snapshot after replacement or deletion. A changed or missing Factory invalidates an execution preview that has not yet been approved. A source classifier may select a current Factory for changed evidence within its existing Routine authority; unchanged source collection still follows the existing zero-model path. A source-free Routine with an explicitly selected Factory runs its work on schedule; source-free routines without a Factory remain fixed reminders. Existing recurring task templates are not converted or reconfigured.

Validation covers exact human confirmation, stale previews, isolation, read-only tools, immutable snapshots, approved agents, branching, verification, budgets, shared task conversations, canvas links and conversation drafts. The opt-in native check is `RUN_RESPONSIBILITY_LIVE=1 pnpm test:run src/main/responsibility-manager.live.test.ts -t 'native Factory branch'`; it uses an isolated local project and database, real Codex sessions, conditional correction, a controlled human answer, and independent verification. It does not exercise a real external PR or substitute for manual desktop acceptance.

## Worker access and recurring verification

New agreements capture the selected agent's existing permission and sandbox settings and show that access in Mastermind. Workers and verifiers use the saved settings; coordination, Routine setup, classification and source interpretation retain their restricted roles. A full-access worker follows the read-only assignment as an instruction, not a filesystem/network security boundary. Credentials and project skills remain in their existing locations. Changing agent settings does not silently broaden an admitted agreement. Old agreements without an access snapshot keep their previous restrictions until explicitly revised; a changed access preview requires review again.

Codex approval responses use the provider's decision format, including session choices and command-policy amendments. The app waits for the exact provider acknowledgement. Unconfirmed delivery is reported as an error rather than silently recording success; answering an old card cannot approve a different command. Acknowledgement confirms delivery of the decision, not successful execution of the command.

When project inspection is needed for a recurring request, Mastermind uses `prepare_routine`. One worker gathers source details, then a restricted setup step drafts a Routine from that same recorded human request. The setup step can inspect configured MCP tool schemas and save its own Routine proposal, but cannot activate it or run project commands. The engineer still reviews the source trial and activates the proposal. Preparation is not an active schedule.

A Routine can explicitly enable `stopOnSuccess`. Work or source classification reports `complete` with evidence to request independent verification; ordinary `done` still finishes only the current check. Verification success completes monitoring and removes the next scheduled run. Unsuccessful verification returns to monitoring within its remaining limits. Access failures, missing evidence and uncertainty remain visible; absence of traffic is not success. Existing Routines default to continued monitoring. When stopping on success is enabled, the first scheduled check is classified even if its evidence matches the trial, so a condition already satisfied at activation is not missed.

Acceptance covers approval acknowledgement and timeout, explicit access snapshots and legacy behavior, preparation through human trial/activation, two checks followed by independent completion, no overlapping check, unsuccessful verification and permission questions. Native acceptance uses isolated local fixtures and real Codex sessions; it does not claim live production service verification.
