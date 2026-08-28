/**
 * PER-AGENT MCP TOOL LIMITS — defect G2, and why it existed at all.
 *
 * `AgentMcpServerEntry.enabledTools` has been in the schema and in
 * `AgentForm.tsx` all along. It was read in exactly ONE place —
 * `resolveDocumentedMcpServers`, which decides what the tool list in
 * `AGENTS.md` and `CLAUDE.md` SAYS — and dropped in the place that decides what
 * the session actually RECEIVES, `buildMcpServersForAdapter`. So the memory
 * file advertised two tools while the agent held six, and every test of the
 * documentation passed.
 *
 * THAT IS A TWO-READER BUG, and reading the field in the second place too would
 * only reduce the odds of it recurring. So both readers now go through this
 * module. If a third appears, it goes through here as well.
 *
 * The parsing rules are deliberately identical to
 * `packages/core/src/services/coding-agents/enabled-tools.ts` in
 * workflow-builder, because the two products read the SAME stored shape and a
 * cloud agent and a desktop agent configured identically must reach identically
 * many tools. The files are separate only because the repositories are.
 */

/** Entry shape stored in `agent.config.mcp_servers`. */
export interface AgentMcpServerEntryLike {
  serverId: string
  /** `undefined` = every tool. An empty array = no tools. */
  enabledTools?: string[]
}

/**
 * The limit for one server.
 *
 * `undefined` means UNRESTRICTED — every tool the server exposes. It is a
 * distinct value from `[]`, which means no tools at all. Conflating the two is
 * the defect in miniature: it turns "I restricted this agent to nothing" into
 * "I restricted this agent to everything".
 */
export type ServerToolLimit = string[] | undefined

/** Keep only non-empty strings, dropping duplicates and preserving order. */
function cleanToolNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) seen.add(entry)
  }
  return [...seen]
}

/**
 * Read `{ serverId -> limit }` out of an agent's `config.mcp_servers`.
 *
 * NEVER THROWS. The config is untyped JSON written by more than one version of
 * the app, so a malformed entry must not be able to take down session startup —
 * but nor may it silently widen access, so anything unparseable is simply
 * treated as having no configured limit rather than being invented.
 */
export function readServerToolLimits(
  entries: Array<string | AgentMcpServerEntryLike> | undefined | null
): Map<string, ServerToolLimit> {
  const limits = new Map<string, ServerToolLimit>()
  if (!Array.isArray(entries)) return limits

  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.length > 0 && !limits.has(entry)) limits.set(entry, undefined)
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const serverId = (entry as AgentMcpServerEntryLike).serverId
    if (typeof serverId !== 'string' || serverId.length === 0) continue
    const raw = (entry as AgentMcpServerEntryLike).enabledTools
    limits.set(serverId, raw === undefined ? undefined : (cleanToolNames(raw) ?? undefined))
  }

  return limits
}

/**
 * THE ALLOWLIST FOR ONE SERVER — `server.tools INTERSECT enabledTools`.
 *
 * The INTERSECTION, not the configured list. A stale `enabledTools` naming a
 * tool the server no longer exposes must not resurrect it, and a server that
 * grows a new tool must not hand it to an agent whose owner never approved it.
 *
 * An ABSENT OR EMPTY limit means every tool the server advertises — which is
 * what a server added with no tools ticked has always meant in `AgentForm`.
 */
export function resolveAllowedToolNames(params: {
  serverTools: Array<{ name: string }> | undefined
  limit: ServerToolLimit
}): string[] {
  const advertised = (params.serverTools ?? []).map((tool) => tool.name).filter(Boolean)
  const { limit } = params
  if (!limit || limit.length === 0) return advertised
  const allowed = new Set(limit)
  return advertised.filter((name) => allowed.has(name))
}

/**
 * The tools an agent may NOT use from a server.
 *
 * Returned rather than the allowed set because the Claude SDK expresses a
 * per-tool limit as `disallowedTools`, and because a DENY list degrades safely:
 * a tool the server adds later is absent from the deny list and therefore
 * allowed, which is the same behaviour as an unrestricted server. An
 * allow-list-only adapter option would silently block new tools instead.
 */
export function resolveDisallowedToolNames(params: {
  serverTools: Array<{ name: string }> | undefined
  limit: ServerToolLimit
}): string[] {
  const { limit } = params
  if (!limit || limit.length === 0) return []
  const allowed = new Set(resolveAllowedToolNames(params))
  return (params.serverTools ?? [])
    .map((tool) => tool.name)
    .filter((name) => Boolean(name) && !allowed.has(name))
}

/**
 * The identifier Claude Code uses for an MCP tool: `mcp__<server>__<tool>`.
 *
 * Used to build `disallowedTools`, which the SDK documents as removing a tool
 * from the model's context entirely — so the limit is enforced BEFORE the model
 * can ask for the tool, not by refusing it afterwards.
 */
export function claudeToolId(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

/**
 * The per-tool enable map OpenCode takes on `session.prompt`.
 *
 * OpenCode has no per-server tool filter when a server is registered, so the
 * limit travels with the prompt instead. Only DENIED tools are listed, and
 * explicitly as `false`: an allow map would have to enumerate every built-in
 * tool as well, and forgetting one would disable it.
 *
 * BOTH NAMING FORMS ARE EMITTED. OpenCode has used `<server>_<tool>` and
 * `<server>__<tool>` across versions, and a key that matches nothing is inert —
 * so listing both costs nothing and is robust to the version in the sandbox,
 * whereas guessing one and being wrong disables nothing at all and looks
 * exactly like success.
 */
export function opencodeDisallowedToolMap(
  servers: Record<string, { name?: string; enabledTools?: string[]; knownTools?: string[] }>
): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const [serverName, config] of Object.entries(servers)) {
    const denied = resolveDisallowedToolNames({
      serverTools: (config.knownTools ?? []).map((name) => ({ name })),
      limit: config.enabledTools
    })
    for (const tool of denied) {
      map[`${serverName}_${tool}`] = false
      map[`${serverName}__${tool}`] = false
      map[tool] = false
    }
  }
  return map
}
