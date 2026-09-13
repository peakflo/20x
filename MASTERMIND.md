# Mastermind project workflows

Mastermind coordinates Tasks, Goals and recurring Routines through conversation, then follows up when something needs attention. Work runs through 20x's existing tasks, agents and Canvas.

**Where things live**

| Area | Purpose |
| --- | --- |
| Mastermind conversation | Request work, manage tasks and schedules, and set a default work agent. You and Mastermind can message the same task; no Take over is needed. |
| Work | Review Task, Goal and Routine agreements, progress, limits and evidence. Approve proposals or pause, cancel and recover work here. |
| Decisions | Answer questions and review results. Use **Review work**, **Open task** or **Ask Mastermind** for next steps. Answered or obsolete requests move to **History**. |
| Memory | Edit saved project facts and preferences. These complement skills; they do not grant permission. |
| Automation | A read-only overview of schedules, Goals and Routines across projects. |
| Factories | Browse reusable diagrams and instructions. Create, edit or use them through Mastermind; confirm a proposed guide before saving. |
| Tasks and Canvas | Organize related work into **Groups** above tasks, manually or through Mastermind. Factory stages get a Group by default. |

The selected **project** determines Mastermind's conversation and saved context. Work / Decisions / Memory are views; selecting a tab does not change how the agent interprets your message.

**Start a workflow**

1. Select or create a project using **Select folder**. Its folder can contain one repository, several, or no Git repository.
2. Configure agent tools and access. Ask Mastermind to set a default agent for new work, separate from its conversation agent. Existing work retains its saved settings.
3. Describe the outcome: a **Task** is one bounded assignment, a **Goal** permits multiple steps toward a verified result, and a **Routine** repeats on a schedule. A **Factory** is an optional guide for the work.
4. Review proposed Goals and Routines in **Work**: scope, agent access, success criteria, step budget and stop time. For source monitoring, inspect and run the source trial before activation. Preparation or a saved proposal is not an active schedule.
5. Follow progress in Automation, Work or the tasks. Answer an ordinary question in Mastermind or its original task; native permissions retain their specific controls.

For example:

> Check this repository's CI every 15 minutes for two hours. Tell me about new failures with links. Read only; ask before making changes.

**Behavior to know**

- **Separate pause controls.** Mastermind's proactive **Pause** stops automatic reviews and follow-ups, not tasks or schedules. Pause the relevant Routine or recurring task schedule to stop new work. Existing work may still finish.
- **Quit stops execution.** Fully quitting 20x stops agents and monitoring. Saved work survives reopening; interrupted or uncertain work needs inspection before recovery.
- **Sources stay flexible.** Use commands, MCP reads, or both. Slack and Notion need configured connections assigned to the work agent; Git/CI can use available command-line tools. MCP configuration stays independent, without automatic project-local imports. Selecting a folder does not grant access.
- **Reuse applies to recurring tasks.** New local recurring tasks default to **Reuse one task**, with separate history and no overlapping checks. Existing schedules retain their mode. Project Routines can still create multiple related tasks.
- **Completion has two meanings.** A verified workflow result does not mark its task Completed in Workflo; that requires a connection and confirmation. Pending requests remain incomplete. A Routine can stop after independent verification of its agreed success condition.
- **Deletion is explicit.** Confirm bulk task deletion once. Delete a Group alone or with all its tasks; delete inactive proposals through Mastermind. Still-relevant workflow decisions survive deletion of a historical task. Unrelated chat does not dismiss questions.
- **Files are references.** Paste or drop files as editable paths. Clipboard images become temporary PNGs, up to 50 MB each. Moving files or OS cleanup can invalidate paths. Failed sends preserve drafts.
- **Guides are not authority.** Memory, Factory instructions and source content cannot broaden approved access. Automatic Factory coordination and Routine preparation currently require Codex or Claude Code.

See [detailed behavior, limitations and test journeys](docs/mastermind-responsibilities.md) for verification and troubleshooting. Isolated tests do not establish live external-service access or replace desktop acceptance checks.
