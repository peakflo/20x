import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { YouTrackConfigForm } from './YouTrackConfigForm'

afterEach(cleanup)

// Mock pluginApi
const mockResolveOptions = vi.fn()
vi.mock('@/lib/ipc-client', () => ({
  pluginApi: {
    resolveOptions: (...args: unknown[]) => mockResolveOptions(...args)
  }
}))

// Mock electronAPI
const mockOpenExternal = vi.fn()
beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).electronAPI = {
    shell: { openExternal: mockOpenExternal }
  }
  mockResolveOptions.mockReset()
  mockOpenExternal.mockReset()
})

describe('YouTrackConfigForm', () => {
  it('renders server URL and token inputs', () => {
    render(<YouTrackConfigForm value={{}} onChange={vi.fn()} />)

    expect(screen.getByLabelText('Server URL')).toBeDefined()
    expect(screen.getByLabelText('Permanent Token')).toBeDefined()
  })

  it('renders test connection button', () => {
    render(<YouTrackConfigForm value={{}} onChange={vi.fn()} />)

    const btn = screen.getByRole('button', { name: /test connection/i })
    expect(btn).toBeDefined()
    // Button should be disabled when no credentials
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('enables test connection button when credentials are provided', () => {
    render(
      <YouTrackConfigForm
        value={{ server_url: 'https://youtrack.example.com', api_token: 'perm:test' }}
        onChange={vi.fn()}
      />
    )

    const btn = screen.getByRole('button', { name: /test connection/i })
    expect(btn.hasAttribute('disabled')).toBe(false)
  })

  it('calls resolveOptions on test connection click', async () => {
    mockResolveOptions.mockResolvedValue([
      { value: 'PROJ', label: 'My Project (PROJ)' }
    ])

    render(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123' }}
        onChange={vi.fn()}
      />
    )

    const btn = screen.getByRole('button', { name: /test connection/i })
    fireEvent.click(btn)

    await waitFor(() => {
      expect(mockResolveOptions).toHaveBeenCalledWith(
        'youtrack',
        'projects',
        expect.objectContaining({
          server_url: 'https://yt.example.com',
          api_token: 'perm:abc123'
        })
      )
    })
  })

  it('shows connected state after successful connection test', async () => {
    mockResolveOptions.mockResolvedValue([
      { value: 'PROJ', label: 'My Project (PROJ)' }
    ])

    render(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123' }}
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByText(/connected/i)).toBeDefined()
    })
  })

  it('shows error state on failed connection test', async () => {
    mockResolveOptions.mockRejectedValue(new Error('Authentication failed'))

    render(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'bad-token' }}
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByText(/authentication failed/i)).toBeDefined()
    })
  })

  it('shows project selector after successful connection', async () => {
    mockResolveOptions.mockResolvedValue([
      { value: 'PROJ', label: 'My Project (PROJ)' },
      { value: 'TEST', label: 'Test Project (TEST)' }
    ])

    render(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123' }}
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined()
    })
  })

  it('does not show filters until project is selected', async () => {
    mockResolveOptions.mockResolvedValue([
      { value: 'PROJ', label: 'My Project (PROJ)' }
    ])

    render(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123' }}
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined()
    })

    // Filter labels should not be present yet
    expect(screen.queryByText('Assignee')).toBeNull()
    expect(screen.queryByText('State')).toBeNull()
    expect(screen.queryByText('Priority')).toBeNull()
  })

  it('shows filter sections when project is selected and connected', async () => {
    // First call (projects), subsequent calls for filters
    mockResolveOptions
      .mockResolvedValueOnce([{ value: 'PROJ', label: 'My Project (PROJ)' }]) // projects
      .mockResolvedValue([]) // all filter calls

    const onChange = vi.fn()
    const { rerender } = render(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123' }}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined()
    })

    // Now rerender with a project selected
    rerender(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123', project: 'PROJ' }}
        onChange={onChange}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Assignee')).toBeDefined()
      expect(screen.getByText('State')).toBeDefined()
      expect(screen.getByText('Priority')).toBeDefined()
      expect(screen.getByText('Type')).toBeDefined()
    })
  })

  it('shows YQL query input when project is selected', async () => {
    mockResolveOptions.mockResolvedValue([{ value: 'PROJ', label: 'My Project (PROJ)' }])

    const { rerender } = render(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123' }}
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByLabelText('Project')).toBeDefined()
    })

    rerender(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123', project: 'PROJ' }}
        onChange={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByLabelText(/additional query/i)).toBeDefined()
    })
  })

  it('calls onChange when server URL is updated', () => {
    const onChange = vi.fn()
    render(<YouTrackConfigForm value={{ server_url: '' }} onChange={onChange} />)

    const input = screen.getByLabelText('Server URL')
    fireEvent.change(input, { target: { value: 'https://new-server.com' } })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ server_url: 'https://new-server.com' })
    )
  })

  it('calls onChange when token is updated', () => {
    const onChange = vi.fn()
    render(<YouTrackConfigForm value={{ api_token: '' }} onChange={onChange} />)

    const input = screen.getByLabelText('Permanent Token')
    fireEvent.change(input, { target: { value: 'perm:newtoken' } })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ api_token: 'perm:newtoken' })
    )
  })

  it('resets connection status when credentials change', async () => {
    mockResolveOptions.mockResolvedValue([{ value: 'PROJ', label: 'My Project (PROJ)' }])

    const onChange = vi.fn()
    render(
      <YouTrackConfigForm
        value={{ server_url: 'https://yt.example.com', api_token: 'perm:abc123' }}
        onChange={onChange}
      />
    )

    // Connect first
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    await waitFor(() => {
      expect(screen.getByText(/connected/i)).toBeDefined()
    })

    // Change server URL — should reset
    const urlInput = screen.getByLabelText('Server URL')
    fireEvent.change(urlInput, { target: { value: 'https://other.com' } })

    // Should show "Test Connection" again (not "Connected")
    expect(screen.getByRole('button', { name: /test connection/i })).toBeDefined()
  })
})
