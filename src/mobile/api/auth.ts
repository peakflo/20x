/**
 * Read the auth token from the URL hash fragment (#token=...).
 * The hash is never sent to the server, keeping the token out of access logs.
 */
let token: string | null = null

export function getAuthToken(): string | null {
  if (token !== null) return token
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  const match = hash.match(/token=([^&]+)/)
  token = match ? decodeURIComponent(match[1]) : null
  return token
}
