import { afterEach, describe, expect, it } from 'vitest'
import {
  brandSpacesEnabled,
  desktopBrandName,
  displayMcpServerName,
  findStoredWorkspaceServer,
  mcpRuntimeName,
  onBrandSpacesChanged,
  organisationWorkspaceName,
  setSelectedCompanyBrand,
  STORED_ORGANISATION_WORKSPACE_NAME
} from './brand'

describe('desktop brand flag and stable MCP identity', () => {
  const previous = process.env.BRAND_SPACES
  afterEach(() => {
    setSelectedCompanyBrand(null)
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

  it('uses the authenticated company on packaged launches and keeps the stored key', () => {
    delete process.env.BRAND_SPACES
    setSelectedCompanyBrand(true)
    expect(brandSpacesEnabled()).toBe(true)
    expect(displayMcpServerName({ name: STORED_ORGANISATION_WORKSPACE_NAME, source: 'enterprise' }))
      .toBe('[Spaces] Organisation Workspace')
    expect(mcpRuntimeName({ name: STORED_ORGANISATION_WORKSPACE_NAME, source: 'enterprise' }))
      .toBe(STORED_ORGANISATION_WORKSPACE_NAME)
    expect(displayMcpServerName({ name: STORED_ORGANISATION_WORKSPACE_NAME, source: 'user' }))
      .toBe(STORED_ORGANISATION_WORKSPACE_NAME)
    process.env.BRAND_SPACES = 'false'
    expect(brandSpacesEnabled()).toBe(false)
  })

  it('adopts an existing user-created workspace row before creating another', () => {
    const userRow = { id: 'saved', name: STORED_ORGANISATION_WORKSPACE_NAME, source: 'user' }
    const oldEnterpriseRow = { id: 'old', name: '[Workflo] MCP Dev Server', source: 'enterprise' }
    expect(findStoredWorkspaceServer([oldEnterpriseRow, userRow])).toBe(userRow)
  })

  it('reports an effective company brand change once and stops after unsubscribe', () => {
    delete process.env.BRAND_SPACES
    setSelectedCompanyBrand(false)
    const changes: boolean[] = []
    const unsubscribe = onBrandSpacesChanged((enabled) => changes.push(enabled))
    setSelectedCompanyBrand(true)
    setSelectedCompanyBrand(true)
    setSelectedCompanyBrand(false)
    unsubscribe()
    setSelectedCompanyBrand(true)
    expect(changes).toEqual([true, false])
  })
})
