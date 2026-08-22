import { describe, it, expect } from 'vitest'

import {
  claudeToolId,
  opencodeDisallowedToolMap,
  readServerToolLimits,
  resolveAllowedToolNames,
  resolveDisallowedToolNames
} from './mcp-tool-limits'

/**
 * DEFECT G2 WRITTEN DOWN AS TESTS.
 *
 * The recurring shape of this bug is a value meaning "restricted" being read as
 * "not restricted", so every case below is really about one distinction:
 * `undefined` (no limit) versus `[]` (a limit of nothing).
 */
describe('readServerToolLimits', () => {
  it('reads an entry with enabledTools, which is what AgentForm writes', () => {
    const limits = readServerToolLimits([{ serverId: 'a', enabledTools: ['one', 'two'] }])
    expect(limits.get('a')).toEqual(['one', 'two'])
  })

  it('treats a bare string and an entry without enabledTools as unrestricted', () => {
    const limits = readServerToolLimits(['a', { serverId: 'b' }])
    expect(limits.get('a')).toBeUndefined()
    expect(limits.get('b')).toBeUndefined()
    // Present, but with no limit — not absent.
    expect(limits.has('a')).toBe(true)
    expect(limits.has('b')).toBe(true)
  })

  it('never throws on a malformed config', () => {
    for (const entries of [undefined, null, 'x', [null, 42, {}, { serverId: '' }]] as never[]) {
      expect(() => readServerToolLimits(entries)).not.toThrow()
    }
  })

  it('drops empty and duplicate tool names', () => {
    const limits = readServerToolLimits([
      { serverId: 'a', enabledTools: ['one', 'one', '', 'two'] }
    ])
    expect(limits.get('a')).toEqual(['one', 'two'])
  })
})

describe('resolveAllowedToolNames', () => {
  const serverTools = [
    { name: 'one' },
    { name: 'two' },
    { name: 'three' },
    { name: 'four' },
    { name: 'five' },
    { name: 'six' }
  ]

  it('returns TWO of SIX when two are enabled', () => {
    expect(resolveAllowedToolNames({ serverTools, limit: ['one', 'two' ] })).toEqual([
      'one',
      'two'
    ])
  })

  it('returns every tool when the limit is absent or empty', () => {
    expect(resolveAllowedToolNames({ serverTools, limit: undefined })).toHaveLength(6)
    expect(resolveAllowedToolNames({ serverTools, limit: [] })).toHaveLength(6)
  })

  it('takes the INTERSECTION, so a stale name cannot resurrect a tool', () => {
    expect(
      resolveAllowedToolNames({ serverTools, limit: ['one', 'deleted_tool'] })
    ).toEqual(['one'])
  })

  it('takes the INTERSECTION, so a NEW upstream tool is not auto-granted', () => {
    const grown = [...serverTools, { name: 'seven' }]
    expect(resolveAllowedToolNames({ serverTools: grown, limit: ['one'] })).toEqual(['one'])
  })
})

describe('resolveDisallowedToolNames', () => {
  const serverTools = [{ name: 'one' }, { name: 'two' }, { name: 'three' }]

  it('names every tool outside the limit', () => {
    expect(resolveDisallowedToolNames({ serverTools, limit: ['one'] })).toEqual([
      'two',
      'three'
    ])
  })

  it('denies NOTHING when the server is unrestricted', () => {
    // The distinction that matters: an unrestricted server must produce an
    // EMPTY deny list, not a deny list of everything.
    expect(resolveDisallowedToolNames({ serverTools, limit: undefined })).toEqual([])
    expect(resolveDisallowedToolNames({ serverTools, limit: [] })).toEqual([])
  })
})

describe('claudeToolId', () => {
  it('uses the mcp__server__tool form the SDK expects', () => {
    expect(claudeToolId('task-management', 'list_tasks')).toBe(
      'mcp__task-management__list_tasks'
    )
  })
})

describe('opencodeDisallowedToolMap', () => {
  it('maps only DENIED tools, and to false', () => {
    const map = opencodeDisallowedToolMap({
      chat: { enabledTools: ['send'], knownTools: ['send', 'delete'] }
    })
    expect(map['chat_delete']).toBe(false)
    expect(map['delete']).toBe(false)
    // An enabled tool must be ABSENT, not present-and-true: an explicit true
    // on a name OpenCode does not recognise is noise, and the absence is what
    // leaves built-ins alone.
    expect(map['chat_send']).toBeUndefined()
    expect(map['send']).toBeUndefined()
  })

  it('is EMPTY for an unrestricted server, so nothing is disabled by accident', () => {
    expect(
      opencodeDisallowedToolMap({
        chat: { knownTools: ['send', 'delete'] }
      })
    ).toEqual({})
  })
})
