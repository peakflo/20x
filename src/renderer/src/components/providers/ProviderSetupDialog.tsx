import { useState } from 'react'
import { Check, ExternalLink, Loader2, AlertCircle, Bot, ArrowRight } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { settingsApi } from '@/lib/ipc-client'

interface ProviderSetupStepProps {
  onComplete: () => void
  error: string | null
  setError: (e: string | null) => void
}

type Provider = 'anthropic' | 'openai' | 'google'

interface ProviderConfig {
  name: string
  displayName: string
  description: string
  keyName: string
  placeholder: string
  docsUrl: string
  recommended?: boolean
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    name: 'Anthropic',
    displayName: 'Anthropic (Claude)',
    description: 'Claude Opus, Sonnet, and Haiku models',
    keyName: 'ANTHROPIC_API_KEY',
    placeholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com',
    recommended: true
  },
  openai: {
    name: 'OpenAI',
    displayName: 'OpenAI (GPT)',
    description: 'GPT-4, GPT-4 Turbo, and GPT-3.5',
    keyName: 'OPENAI_API_KEY',
    placeholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  google: {
    name: 'Google',
    displayName: 'Google AI (Gemini)',
    description: 'Gemini 2.0 Flash and Gemini 1.5 Pro',
    keyName: 'GOOGLE_API_KEY',
    placeholder: 'AI...',
    docsUrl: 'https://makersuite.google.com/app/apikey'
  }
}

export function ProviderSetupStep({ onComplete, error, setError }: ProviderSetupStepProps) {
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!selectedProvider) {
      setError('Please select a provider')
      return
    }

    if (!apiKey.trim()) {
      setError('API key is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const provider = PROVIDERS[selectedProvider]
      await settingsApi.set(provider.keyName, apiKey.trim())
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key')
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = () => {
    onComplete()
  }

  return (
    <>
      <div className="rounded-full bg-primary/10 p-2.5 w-fit mb-4">
        <Bot className="size-5 text-primary" />
      </div>

      <h2 className="text-2xl font-bold text-foreground mb-2">
        Add an AI Provider
      </h2>
      <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
        Choose your preferred AI provider. You can add more providers later in settings.
      </p>

      {!selectedProvider ? (
        <>
          {/* Provider Selection */}
          <div className="space-y-3">
            {Object.entries(PROVIDERS).map(([key, provider]) => (
              <button
                key={key}
                onClick={() => setSelectedProvider(key as Provider)}
                className="w-full text-left rounded-lg bg-muted/30 p-4 hover:bg-muted/50 transition-colors border border-transparent hover:border-border"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">
                      {provider.displayName}
                      {provider.recommended && (
                        <span className="ml-2 text-xs text-primary">Recommended</span>
                      )}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      {provider.description}
                    </p>
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground" />
                </div>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-6">
            <Button variant="ghost" onClick={handleSkip}>
              Skip for now
            </Button>
          </div>
        </>
      ) : (
        <>
          {/* API Key Input */}
          <div className="rounded-lg bg-muted/30 p-4 mb-4">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">
                  {PROVIDERS[selectedProvider].displayName}
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  {PROVIDERS[selectedProvider].description}
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <a
                href={PROVIDERS[selectedProvider].docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Get API Key
                <ExternalLink className="size-3" />
              </a>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="api-key">API Key</Label>
            <Input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={PROVIDERS[selectedProvider].placeholder}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Your API key is stored securely and used only by your local OpenCode server
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20 mt-3">
              <AlertCircle className="size-4 text-destructive mt-0.5" />
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}

          <div className="flex items-center gap-3 mt-6">
            <Button onClick={() => setSelectedProvider(null)} variant="ghost">
              Back
            </Button>
            <Button onClick={handleSave} disabled={!apiKey.trim() || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Continue
            </Button>
            <Button variant="ghost" onClick={handleSkip}>
              Skip for now
            </Button>
          </div>
        </>
      )}
    </>
  )
}
