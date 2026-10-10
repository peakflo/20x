import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { CursorAuthStatus, CursorLoginCompleteEvent } from '@shared/cursor-auth'

const status = vi.fn()
const startBrowserLogin = vi.fn()
const cancelBrowserLogin = vi.fn()
const logout = vi.fn()
let loginCompleteCallback: ((event: CursorLoginCompleteEvent) => void) | null = null
const unsubscribe = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  cursorAuthApi: {
    status: (...args: unknown[]) => status(...args),
    startBrowserLogin: (...args: unknown[]) => startBrowserLogin(...args),
    cancelBrowserLogin: (...args: unknown[]) => cancelBrowserLogin(...args),
    logout: (...args: unknown[]) => logout(...args),
    onLoginComplete: (cb: (event: CursorLoginCompleteEvent) => void) => {
      loginCompleteCallback = cb
      return unsubscribe
    }
  }
}))

import { CursorSettingsCard } from './CursorSettingsCard'

function notSignedIn(): CursorAuthStatus {
  return { authenticated: false, reason: 'Not signed in' }
}
function signedIn(email?: string): CursorAuthStatus {
  return { authenticated: true, email }
}

beforeEach(() => {
  cleanup()
  loginCompleteCallback = null
  status.mockReset().mockResolvedValue(notSignedIn())
  startBrowserLogin.mockReset().mockResolvedValue({ url: 'https://cursor.com/login?token=abc' })
  cancelBrowserLogin.mockReset().mockResolvedValue(undefined)
  logout.mockReset().mockResolvedValue(undefined)
  unsubscribe.mockReset()
})

describe('CursorSettingsCard', () => {
  it('shows "not signed in" and a sign-in button when there is no stored login', async () => {
    render(<CursorSettingsCard />)
    await screen.findByText(/not signed in/i)
    expect(screen.getByRole('button', { name: /sign in with browser/i })).toBeTruthy()
  })

  it('shows the signed-in email and a sign-out action when authenticated', async () => {
    status.mockResolvedValue(signedIn('dev@example.com'))
    render(<CursorSettingsCard />)
    await screen.findByText('dev@example.com')
    expect(screen.getByText('Signed in')).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy()
  })

  it('starts a browser login and opens it immediately, while still showing the URL and a way to reopen it', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<CursorSettingsCard />)
    await screen.findByRole('button', { name: /sign in with browser/i })

    fireEvent.click(screen.getByRole('button', { name: /sign in with browser/i }))
    await waitFor(() => expect(startBrowserLogin).toHaveBeenCalled())

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://cursor.com/login?token=abc', '_blank', 'noopener,noreferrer')
    )
    const urlNode = await screen.findByText('https://cursor.com/login?token=abc')
    expect(urlNode).toBeTruthy()

    openSpy.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /reopen/i }))
    expect(openSpy).toHaveBeenCalledWith('https://cursor.com/login?token=abc', '_blank', 'noopener,noreferrer')
  })

  it('cancels a pending login', async () => {
    render(<CursorSettingsCard />)
    await screen.findByRole('button', { name: /sign in with browser/i })
    fireEvent.click(screen.getByRole('button', { name: /sign in with browser/i }))
    await screen.findByRole('button', { name: /cancel/i })

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(cancelBrowserLogin).toHaveBeenCalled())
  })

  it('signs out and refreshes status', async () => {
    status.mockResolvedValueOnce(signedIn('dev@example.com')).mockResolvedValueOnce(notSignedIn())
    render(<CursorSettingsCard />)
    await screen.findByRole('button', { name: /sign out/i })

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(logout).toHaveBeenCalled())
    await screen.findByText(/not signed in/i)
  })

  it('refreshes status when the main process reports a login completed', async () => {
    render(<CursorSettingsCard />)
    await screen.findByText(/not signed in/i)
    status.mockResolvedValue(signedIn('dev@example.com'))

    expect(loginCompleteCallback).not.toBeNull()
    loginCompleteCallback?.({ success: true, email: 'dev@example.com' })

    await screen.findByText('dev@example.com')
  })

  it('shows the login-failure message reported by the main process', async () => {
    render(<CursorSettingsCard />)
    await screen.findByText(/not signed in/i)

    loginCompleteCallback?.({ success: false, error: 'Login timed out' })
    await screen.findByText('Login timed out')
  })

  it('unsubscribes from the login-complete event on unmount', async () => {
    const { unmount } = render(<CursorSettingsCard />)
    await screen.findByText(/not signed in/i)
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  describe('embedded inside the agent form', () => {
    // Regression: this card is embedded inside AgentForm's <form>, not a
    // standalone Settings section. A <button> with no explicit `type`
    // defaults to type="submit" inside a <form> — clicking it submits the
    // whole agent form and closes the edit dialog. Every button here must
    // opt out of that with type="button", verified by actually submitting
    // the surrounding form, not just inspecting the attribute.
    function renderInsideAForm(ui: ReactElement, onSubmit: () => void) {
      return render(
        <form onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
          {ui}
        </form>
      )
    }

    it('"Sign in with browser" does not submit the surrounding form', async () => {
      const onSubmit = vi.fn()
      renderInsideAForm(<CursorSettingsCard />, onSubmit)
      await screen.findByRole('button', { name: /sign in with browser/i })

      fireEvent.click(screen.getByRole('button', { name: /sign in with browser/i }))
      await waitFor(() => expect(startBrowserLogin).toHaveBeenCalled())
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('"Reopen" and "Cancel" do not submit the surrounding form', async () => {
      const onSubmit = vi.fn()
      renderInsideAForm(<CursorSettingsCard />, onSubmit)
      await screen.findByRole('button', { name: /sign in with browser/i })
      fireEvent.click(screen.getByRole('button', { name: /sign in with browser/i }))
      await screen.findByRole('button', { name: /reopen/i })

      fireEvent.click(screen.getByRole('button', { name: /reopen/i }))
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('"Sign out" does not submit the surrounding form (the reported bug)', async () => {
      status.mockResolvedValue(signedIn('dev@example.com'))
      const onSubmit = vi.fn()
      renderInsideAForm(<CursorSettingsCard />, onSubmit)
      await screen.findByRole('button', { name: /sign out/i })

      fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
      await waitFor(() => expect(logout).toHaveBeenCalled())
      expect(onSubmit).not.toHaveBeenCalled()
    })
  })
})
