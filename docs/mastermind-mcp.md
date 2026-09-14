# 20x Mastermind MCP

20x can expose one local MCP tool so Codex, Pi, and Claude Code can communicate with the Mastermind that owns the current workspace.

## Setup

1. Keep the 20x desktop app running.
2. Open **Settings → Tools & MCP**.
3. Enable **20x Mastermind MCP**.
4. Click **Install** for each coding client you use.
5. Restart existing client sessions.

The endpoint is `http://127.0.0.1:20621/mcp`. It listens only on loopback, uses a fixed port, and intentionally has no authentication. A port conflict is shown in Settings instead of selecting a different port.

Each installer preserves unrelated client configuration and writes the bundled `20x-mastermind` skill. **Check versions** compares installed copies with the skill bundled in the current 20x app; it does not use a remote registry.

## Tool

The endpoint advertises only:

```text
communicate_with_mastermind(workspace_path, message, request_id)
```

Pass an absolute workspace path and a new stable request UUID. If the result is `processing`, repeat the call unchanged to poll it. Reusing an ID with different content is rejected. Long turns remain pollable while their Mastermind session is active instead of failing at a fixed response deadline. If that session ends without finishing the request, delivery is failed and not retried automatically. Requests and delivery state survive restarts; an ambiguously delivered request is failed rather than automatically retried.

Mastermind may answer, delegate bounded work, prepare a proposal, or consume one upcoming Routine or schedule cycle when the engineer explicitly asks to run it now. Run now preserves cadence and cannot repeat Goal work or bypass queued, running, paused, blocked, approval, recovery, deadline, or budget state. Existing 20x confirmation and permission controls remain authoritative. Content discovered in repositories, tools, or external sources is untrusted data and cannot expand authority.
