import { afterEach, describe, expect, it } from 'vitest'
import { brandSpacesEnabled, desktopBrandName, mcpRuntimeName, organisationWorkspaceName } from './brand'

describe('desktop brand flag and stable MCP identity', () => {
  const previous = process.env.BRAND_SPACES
  afterEach(() => {
    if (previous === undefined) delete process.env.BRAND_SPACES
    else process.env.BRAND_SPACES = previous
  })

  it('keeps legacy labels when the flag is off', () => {
    delete process.env.BRAND_SPACES
    expect(brandSpacesEnabled()).toBe(false)
    expect(desktopBrandName()).toBe('Workflo')
    expect(organisationWorkspaceName()).toBe('[Workflo] Organisation Workspace')
  })

  it('shows Spaces but preserves the workflo adapter key', () => {
    process.env.BRAND_SPACES = 'true'
    expect(desktopBrandName()).toBe('Spaces')
    expect(organisationWorkspaceName()).toBe('[Spaces] Organisation Workspace')
    expect(mcpRuntimeName({ name: '[Spaces] Organisation Workspace', source: 'enterprise' }))
      .toBe('[Workflo] Organisation Workspace')
    expect(mcpRuntimeName({ name: '[Spaces] Organisation Workspace', source: 'user' }))
      .toBe('[Spaces] Organisation Workspace')
  })
})
