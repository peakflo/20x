const SESSION_TOKEN_KEY = '20x_session_token'

let token: string | null = null

export function getAuthToken(): string | null {
  if (token !== null) return token
  token = typeof window !== 'undefined' ? localStorage.getItem(SESSION_TOKEN_KEY) : null
  return token
}

export function saveSessionToken(t: string): void {
  token = t
  localStorage.setItem(SESSION_TOKEN_KEY, t)
}

export function clearSessionToken(): void {
  token = null
  localStorage.removeItem(SESSION_TOKEN_KEY)
}

export function hasSessionToken(): boolean {
  return !!getAuthToken()
}

/** Read ?code= from URL search params (used on QR scan landing). */
export function getPairCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('code')
}

/** Strip ?code= from URL without reloading. */
export function clearPairCodeFromUrl(): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.delete('code')
  window.history.replaceState({}, '', url.pathname + (url.search !== '?' ? url.search : ''))
}
