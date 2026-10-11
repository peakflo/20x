import { useCallback, useEffect, useState } from 'react'
import { settingsApi } from '@/lib/ipc-client'

/** Persisted separately from any profile field — this is just "what the share card should say", editable independent of the user's real account name. */
const USAGE_CARD_NAME_SETTING = 'usage-share-card-name'

/** Best-effort default: the local part of the signed-in email, capitalized. Empty when no email is known. */
function defaultNameFromEmail(email: string | null): string {
  if (!email) return ''
  const local = email.split('@')[0] ?? ''
  const cleaned = local.replace(/[._-]+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase())
}

export interface UsageCardNameState {
  name: string
  /** True until the persisted/default value has loaded — callers can hold off drawing a name-dependent card momentarily to avoid a flash from '' to the real value. */
  loaded: boolean
  setName: (name: string) => void
}

/** The name shown on the usage share card ("<name>, last 30 days"). Persisted so it's remembered across sessions; defaults from the signed-in email the first time. */
export function useUsageCardName(): UsageCardNameState {
  const [name, setNameState] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = await settingsApi.get(USAGE_CARD_NAME_SETTING).catch(() => null)
      if (cancelled) return
      if (stored !== null && stored !== undefined) {
        setNameState(stored)
      } else {
        const email = await settingsApi.get('current_user_email').catch(() => null)
        if (!cancelled) setNameState(defaultNameFromEmail(email))
      }
      if (!cancelled) setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setName = useCallback((next: string) => {
    setNameState(next)
    void settingsApi.set(USAGE_CARD_NAME_SETTING, next)
  }, [])

  return { name, loaded, setName }
}
