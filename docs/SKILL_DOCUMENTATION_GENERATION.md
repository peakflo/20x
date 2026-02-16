# Skill Documentation Generation

## Overview

On every agent session start, the system now automatically generates two documentation files alongside the skill files:

- **`.agents/AGENTS.md`** - Agent-focused skill directory with statistics
- **`.agents/CLAUDE.md`** - Claude-specific configuration with skill reference

## File Locations

When a session starts for task ID `abc123`:

```
workspaces/abc123/
  .agents/
    AGENTS.md          ← Generated session metadata + skill directory
    CLAUDE.md          ← Generated Claude configuration + skill reference
    skills/
      git-release/
        SKILL.md       ← Individual skill content
      code-review/
        SKILL.md
      ...
```

## AGENTS.md Structure

Contains:
- Session metadata (timestamp, agent name, task title)
- All available skills sorted by confidence (high → low)
- For each skill:
  - Clickable link to SKILL.md
  - Confidence percentage
  - Usage count
  - Last used date
  - Tags
  - Description
- Skill statistics table:
  - Total skills
  - Average confidence
  - Total uses
  - Confidence distribution (high/medium/low)

## CLAUDE.md Structure

Contains:
- Session metadata (timestamp, model, agent, task)
- Task instructions and description
- Quick reference list with confidence percentages:
  - e.g., `(85% confidence)`, `(50% confidence)`
- Detailed skills section with:
  - Full skill metadata
  - Clickable paths to SKILL.md files
  - Confidence percentages
  - Usage statistics
  - Tags
- Usage notes for the agent

## Implementation

Modified `src/main/agent-manager.ts`:

### Key Methods

1. **`writeSkillFiles(taskId, agentId, workspaceDir)`**
   - Writes individual SKILL.md files (existing behavior)
   - Calls `writeAgentsDocumentation()` to generate AGENTS.md and CLAUDE.md

2. **`writeAgentsDocumentation(workspaceDir, skills, agent, task)`**
   - Sorts skills by confidence
   - Generates both documentation files
   - Writes to `.agents/` directory

3. **`generateAgentsMd(skills, agent, task)`**
   - Creates agent-focused documentation
   - Includes skill statistics

4. **`generateClaudeMd(skills, agent, task)`**
   - Creates Claude-specific configuration
   - Includes task instructions
   - Shows confidence as percentages

## Skill Resolution Priority

The system determines which skills to include based on:

1. **Task-level** (`task.skill_ids`) - highest priority
2. **Agent-level** (`agent.config.skill_ids`) - fallback
3. **All skills** - if both above are undefined/null

## Automatic Updates

These files are regenerated on every session start, ensuring:
- Always current skill confidence levels
- Updated usage statistics
- Latest skill descriptions
- Accurate last-used timestamps

## Benefits

1. **For Agents:**
   - Quick reference to available skills
   - Confidence-based prioritization
   - Usage statistics for informed decisions

2. **For Claude:**
   - Clear task context
   - Skill capabilities overview
   - Confidence percentages
   - Direct links to detailed skill content

3. **For Developers:**
   - Session reproducibility
   - Skill effectiveness tracking
   - Easy debugging of skill selection

## Example Output

See the test run above for complete examples of both AGENTS.md and CLAUDE.md formats with 5 sample skills sorted by confidence (85%, 78%, 72%, 65%, 50%).

## Future Enhancements

Potential additions:
- Skill compatibility matrix (which skills work well together)
- Session history links (similar tasks that used these skills)
- Skill recommendation engine based on task type
- Performance metrics per skill
- Skill dependency graphs
