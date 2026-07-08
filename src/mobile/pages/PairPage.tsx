import { useState, useEffect, useRef } from 'react'
import { saveSessionToken, clearPairCodeFromUrl } from '../api/auth'

interface Props {
  pairCode: string
  onPaired: () => void
}

export function PairPage({ pairCode, onPaired }: Props) {
  const [pairCodeId, setPairCodeId] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [initiating, setInitiating] = useState(true)
  const [secondsLeft, setSecondsLeft] = useState(60)
  const expiresAtRef = useRef<number>(Date.now() / 1000 + 60)

  useEffect(() => {
    async function initiate() {
      try {
        const res = await fetch('/api/auth/pair/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: pairCode })
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to initiate pairing')
        setPairCodeId(data.pairCodeId)
        expiresAtRef.current = Date.now() / 1000 + data.expiresIn
        setSecondsLeft(data.expiresIn)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to connect')
      } finally {
        setInitiating(false)
      }
    }
    void initiate()
  }, [pairCode])

  // Countdown timer
  useEffect(() => {
    if (!pairCodeId) return
    const interval = setInterval(() => {
      const left = Math.max(0, Math.floor(expiresAtRef.current - Date.now() / 1000))
      setSecondsLeft(left)
      if (left === 0) clearInterval(interval)
    }, 1000)
    return () => clearInterval(interval)
  }, [pairCodeId])

  async function handleVerify() {
    if (!pairCodeId || pin.length !== 6) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/pair/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairCodeId, pin })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Verification failed')
      saveSessionToken(data.sessionToken)
      clearPairCodeFromUrl()
      onPaired()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
      setPin('')
    } finally {
      setLoading(false)
    }
  }

  if (initiating) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Connecting...</p>
        </div>
      </div>
    )
  }

  if (error && !pairCodeId) {
    return (
      <div className="h-full flex items-center justify-center bg-background p-6">
        <div className="text-center space-y-4 max-w-xs">
          <div className="text-4xl">⚠️</div>
          <h2 className="font-semibold text-foreground">Connection Failed</h2>
          <p className="text-sm text-muted-foreground">{error}</p>
          <p className="text-xs text-muted-foreground">Please scan the QR code again from the 20x desktop app.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-xs space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold text-foreground">Enter PIN</h1>
          <p className="text-sm text-muted-foreground">
            Check the 20x desktop app for your 6-digit PIN
          </p>
        </div>

        <div className="space-y-3">
          <input
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
            placeholder="000000"
            className="w-full text-center text-3xl font-mono tracking-widest bg-accent/30 border border-border rounded-xl px-4 py-4 text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            autoFocus
          />

          {error && (
            <p className="text-sm text-red-400 text-center">{error}</p>
          )}

          <p className="text-xs text-muted-foreground text-center">
            {secondsLeft > 0 ? `PIN expires in ${secondsLeft}s` : 'PIN expired — please scan QR again'}
          </p>
        </div>

        <button
          onClick={handleVerify}
          disabled={pin.length !== 6 || loading || secondsLeft === 0}
          className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {loading ? 'Verifying...' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
