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

## Product boundaries

- A Task is one assignment per direct human turn (a clarification renews one bounded step), a Goal authorizes necessary continuation, and a Routine authorizes recurring attention. Related Tasks do not automatically become Goals.
- Project files may be one repository, several repositories, or a non-Git folder. A worker can create an isolated checkout inside the approved project; follow-ups retain the reported checkout.
- Existing provider approval and sandbox controls remain in force. New orchestration tools never accept a model-supplied approval flag. Human agreement changes are available only through desktop IPC; worker tools have server-owned, revocable assignment scopes.
- Sources are finite commands selected through conversation and explicitly trialed by the engineer. No fixed monitoring catalog or additional connector framework is required. Commands should print stable source snapshots, omitting volatile polling timestamps.
- Merge, deployment, production mutation, destructive data operations, secrets and external communication require direct human approval. No source, worker result or remembered preference can enlarge that authority.
- Step budgets include work, source classification and verification. Deadline and repeated no-progress checks stop additional admission. Pausing does not abandon observation.
- Results record the actual checkout, revision and working-file fingerprint. Large checkouts that exceed the bounded inspection limit require a narrower working checkout; this is reported rather than silently counted as verified.

## Validation record

Implementation validation, regression coverage, and live product evidence are recorded in the PR. Unit tests with a controlled agent prove control-plane behavior, not actual provider execution. No merge or deployment is part of this change.

The native Codex worker/verifier journey passed against a temporary non-Git project through the real HTTP MCP endpoint. Both tasks settled with matching file fingerprints and both runtimes were released. The full regression suite passed with process inspection enabled; focused lifecycle, provider, renderer, and IPC checks cover the final changes. Counts and commands are recorded in the PR.

The built desktop app opened with an isolated temporary database. Visual interaction could not be completed because the computer-use service was not approved to access the generic Electron application. Renderer and IPC checks are automated; no manual desktop acceptance or full working-day soak is claimed.
