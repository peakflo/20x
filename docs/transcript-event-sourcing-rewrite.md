# Transcript rewrite: event-sourced projection-render (t3 model)

## Why

Today the rendered transcript is an **in-memory `AgentMessage[]` the renderer owns and
mutates**, written by **four independent mechanisms**:

1. Live push — `agent:output` / `agent:output-batch` events *append*.
2. Hydration — `hydrateTranscript` reads the projection and *merges/replaces*.
3. Resume-replay — on send-after-restart the backend re-spawns the CLI and *pushes the whole thread again*.
4. Session re-key / `initSession` / `clearMessageDedup` — *reset / re-point* the array.

Every state transition (send, resume, re-key, idle, reload) is a chance for these writers
to disagree → the symptoms we chased for days: reorder, overlap, only-user-side,
collapse-on-send, re-stamped timestamps. Patching each disagreement is endless.

## Target (t3) principle

**The server projection is the single source of truth. The client renders it as a pure
function of server state. There is exactly ONE read path.** No client-owned mutable list,
no rehydration-as-a-special-case, no replay push, no re-key dance.

- Server: events → durable log/projection (`transcript_parts`, already exists) → the current
  thread state.
- Client: holds a `Map<partId, part>` **projection cache** and renders a derived, sorted
  list. It updates the cache from (a) a full snapshot on bind and (b) idempotent deltas.
  Because the cache is keyed by stable `part_id`, dedup/reorder/duplication are impossible.
- Send / reload / reconnect / background-wake are all the *same* path: read projection → render.

## What already exists (keep)

- `transcript_parts` table + `upsertTranscriptParts` (upsert by `(task_id, part_id)`; streaming
  updates replace content in place). `database.ts`.
- Write-through at the emit chokepoint: `AgentManager.sendToRenderer` → `persistTranscriptEvent`
  persists every non-ephemeral part with real `receivedAt` → `created_at`. `agent-manager.ts`.
- Ordering by real time: `getTranscriptParts` `ORDER BY created_at, seq`. `database.ts`.
- One-time full-history backfill from the adapter session (`getPersistedMessages`). `agent-manager.ts`.
- Snapshot IPC `agentSession:getTranscriptSnapshot`. `ipc-handlers.ts` / preload / `ipc-client.ts`.
- `AgentTranscriptPanel` already renders from a `messages: AgentMessage[]` prop and groups
  tool/reasoning parts — it can stay almost as-is; we only change where `messages` comes from.

## What to delete (the four competing writers)

- Renderer store: the `onAgentOutput` / `onAgentOutputBatch` accumulation as the source of
  truth; `seenIds` + `renderedIds` dedup sets; `clearMessageDedup`; the additive-vs-replace
  branching inside `hydrateTranscript`; session re-key logic that resets `messages`.
- `use-agent-session.ts`: `clearMessageDedup` on resume (already removed), and any
  message-resetting on `initSession`.
- `agent-manager.ts`: the resume **replay-to-renderer** push (`resumeAdapterSession` /
  `replaySessionMessages` sending full `agent:output-batch` to the renderer). The projection
  already survives restart; the client re-reads it. (Backend still reads the CLI to *ingest*
  into the projection — that's the backfill, not a renderer push.)

---

## Phase 0 — Make the projection provably complete (mostly done; verify)

Goal: every renderable part is in `transcript_parts` at emit time, with real time, and
streaming updates land as content upserts.

Steps:
1. Audit the ~9 `sendToRenderer('agent:output'|'agent:output-batch')` sites in `agent-manager.ts`.
   Confirm each part reaching `persistTranscriptEvent` has a stable `id` and (for streamed
   assistant text) that the *update* events upsert the same `part_id` (content replace).
2. Confirm `receivedAt` is threaded on the live path (not just replay) so `created_at` is real
   for live messages too. (Live parts currently often lack `receivedAt` → fall back to write
   time; acceptable, but prefer real time where the adapter provides it.)
3. Decide policy for `system-status` / `step-start` / `step-finish`: keep excluded (they’re UI-
   transient), but make sure nothing *renderable* is excluded.

Verify (CDP): `getTranscriptSnapshot(taskId).length` and assistant-text count match the CLI
session file (`~/.claude/projects/.../<session>.jsonl`) and the on-disk `pf-desktop.db`
`transcript_parts` for the task.

Exit criteria: snapshot == ground truth for a long, restarted session. (This was TRUE in the
last verification: 708 parts / 241 assistant-text.)

---

## Phase 1 — Server: revision counter + delta query + change notification

Goal: let the client fetch *only what changed* and know *when* to fetch, so we never push
message content as the source of truth.

Changes:

1. `database.ts`
   - Add a per-task monotonic `revision` (simplest: a global `AUTOINCREMENT` rowid column
     `rev INTEGER` on `transcript_parts`, or a `MAX(updated_at)` cursor). Prefer a dedicated
     `rev` bumped on every insert/update so both new parts and content-updates are captured.
     Implementation: `rev = (SELECT COALESCE(MAX(rev),0)+1 FROM transcript_parts)` on each
     upserted row (global monotonic), stored per row.
   - `getTranscriptDelta(taskId, sinceRev): TranscriptPartRecord[]` → rows with `rev > sinceRev`
     ordered by `created_at, seq`. Also return `maxRev`.
   - Keep `getTranscriptParts` (full snapshot) — snapshot = delta since 0.

2. `agent-manager.ts`
   - In `persistTranscriptEvent`, after `upsertTranscriptParts`, emit a lightweight
     `this.sendToRenderer('transcript:changed', { taskId, maxRev })` **containing only the
     changed part ids + their new rev** (a delta payload), NOT the whole thread. This is the
     low-latency streaming path: the delta *is* the render update, applied idempotently by id.
   - IMPORTANT: `transcript:changed` must NOT go through `persistTranscriptEvent` (no recursion)
     — send it directly to the window/external listeners.
   - Remove the resume replay-to-renderer push (see “delete” list). Resume still ingests to the
     projection (backfill), which triggers `transcript:changed` naturally.

3. IPC wiring (5 files): `ipc-handlers.ts` (`agentSession:getTranscriptDelta`), `preload/index.ts`,
   `renderer/src/types/electron.d.ts`, `renderer/src/lib/ipc-client.ts`, plus an
   `onTranscriptChanged(cb)` subscription (mirror `onAgentOutput`).

Verify (CDP/unit): delta since a known rev returns exactly the parts changed after it,
including a content-update to an existing streamed message.

---

## Phase 2 — Renderer: projection-cache store (parallel, behind a flag)

Goal: build the new model next to the old one so we can cut over safely.

Changes to `agent-store.ts`:

1. New per-task state: `projection: Map<taskId, { parts: Map<partId, ProjPart>, rev: number }>`.
   `ProjPart` = `{ id, role, content, partType, tool, taskProgress, createdAt, seq, stepMeta? }`.
2. `bindTranscript(taskId)`:
   - `const snap = await getTranscriptSnapshot(taskId)`; build the parts Map; store `rev = maxRev`.
3. `onTranscriptChanged(({taskId, parts /*delta*/, maxRev}))`:
   - Upsert each delta part into the Map by id (idempotent). Set `rev = maxRev`.
   - If a gap is detected (`maxRev` jumps past what we have), fall back to
     `getTranscriptDelta(taskId, ourRev)` once. Robust against dropped events.
4. Derived selector `selectMessages(taskId): AgentMessage[]` = `[...parts.values()]` sorted by
   `(createdAt, seq)`. `useMemo` in the component or a memoized store selector.

This is a **pure cache**: only two mutations (snapshot load, delta upsert), both idempotent and
keyed by id. No append/replace/clear/re-key. Reorder/dup/collapse are structurally impossible.

Verify: with the flag on, CDP-read the projection Map size == snapshot size; `selectMessages`
length == store; DOM virtual-list height reflects full history after reload AND after send.

---

## Phase 3 — Cut over the component + delete the old writers

1. `use-agent-session.ts`: `messages` now comes from `selectMessages(taskId)` (projection),
   not `session.messages`. On mount call `bindTranscript(taskId)`. Remove `hydrateTranscript`
   usage.
2. `AgentTranscriptPanel.tsx`: unchanged rendering logic (it already takes `messages` +
   groups). It just receives the derived list. Keep the virtualizer.
3. Delete from `agent-store.ts`: `onAgentOutput`/`onAgentOutputBatch` accumulation into
   `messages`, `seenIds`, `renderedIds`, `clearMessageDedup`, `hydrateTranscript`’s
   additive/replace body, the re-key-resets-messages branches. Keep `onAgentStatus` only for
   status/pendingApproval (working/idle/waiting), NOT for message content.
4. `agent-manager.ts`: delete `replaySessionMessages`/`resumeAdapterSession` replay-to-renderer
   pushes; keep resume for backend continuation + projection ingest only.
5. Live status (working/idle/approval) stays event-driven via `agent:status`; that’s session
   *state*, not transcript content, so it doesn’t belong in the projection.

Verify (the whole point): after cutover, run the full matrix (below) via CDP — every symptom
we chased should be gone because there is one writer.

---

## Phase 4 — Cleanup + guardrails

- Remove now-dead IPC (`agent:output` transcript role, if fully replaced) OR keep `agent:output`
  only as a `transcript:changed` trigger. Simplify preload surface.
- Mobile: point the mobile transport at the same snapshot/delta API (mobile currently relies on
  the replay push — give it the projection subscription so removing the push doesn’t regress it).
- Add a store-level invariant test: applying the same delta twice is a no-op; out-of-order
  deltas converge; a gap triggers a delta refetch.

---

## Verification matrix (run every phase via the DevTools/CDP loop)

Connect: `curl http://127.0.0.1:19222/json` → page target for `localhost:5173` → CDP
`Runtime.evaluate`. Checks:

- **Data**: `getTranscriptSnapshot(taskId)` count + assistant-text count == `pf-desktop.db`
  `transcript_parts` == CLI `.jsonl`.
- **Store**: projection Map size == snapshot; `selectMessages` length == Map size.
- **DOM**: virtual-list inner height large (full history present); scroll to top shows oldest.
- **Scenarios** (each must preserve full history, correct order, real timestamps, no overlap):
  1. Cold reload (app restart) → open task.
  2. Send a message after restart.  ← the current failing case.
  3. Idle → resume → send.
  4. Background wake / another window.
  5. Long session (>10k parts) — virtualizer + no eviction bugs.

Exit criteria for the whole rewrite: scenarios 1–5 all pass with **zero** transcript-specific
patches beyond the projection read path.

---

## Risk / sequencing notes

- Do Phase 2 **behind a flag** and keep the old path until Phase 3 cutover, so a bad build never
  regresses the transcript again.
- Streaming latency: the delta-in-`transcript:changed` payload keeps token streaming immediate
  (no snapshot round-trip per token); idempotent by id so it can’t reorder.
- `transcript:changed` recursion: never route it through `persistTranscriptEvent`.
- Keep `#421` (subagent lifecycle) and this rewrite independent. This supersedes the
  hydration/dedup churn currently on `feat/durable-transcript-projection`; consider landing the
  rewrite as a fresh branch and dropping the accumulated patch commits.
- Every phase verified with the live CDP loop — **no blind commits**. That’s the single biggest
  lesson from the first attempt.
