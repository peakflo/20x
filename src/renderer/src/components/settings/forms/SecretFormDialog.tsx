import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import type { Secret, CreateSecretDTO, UpdateSecretDTO } from '@/types'

interface SecretFormDialogProps {
  secret?: Secret
  open: boolean
  onClose: () => void
  // Re-review (P2): returns whether the submit actually succeeded, so the
  // dialog can stay open (with the caller's error banner still visible)
  // instead of closing — and silently discarding the form — on failure.
  onSubmit: (data: CreateSecretDTO | UpdateSecretDTO) => Promise<boolean>
}

const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export function SecretFormDialog({ secret, open, onClose, onSubmit }: SecretFormDialogProps) {
  const [name, setName] = useState(secret?.name ?? '')
  const [description, setDescription] = useState(secret?.description ?? '')
  const [envVarName, setEnvVarName] = useState(secret?.env_var_name ?? '')
  const [value, setValue] = useState('')
  const [envVarError, setEnvVarError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setName(secret?.name ?? '')
      setDescription(secret?.description ?? '')
      setEnvVarName(secret?.env_var_name ?? '')
      setValue('')
      setEnvVarError(null)
    }
  }, [open, secret?.id])

  const validateEnvVar = (v: string): boolean => {
    if (!v.trim()) {
      setEnvVarError(null)
      return false
    }
    if (!ENV_VAR_PATTERN.test(v.trim())) {
      setEnvVarError('Must be uppercase letters, digits, and underscores (e.g. MY_API_KEY)')
      return false
    }
    setEnvVarError(null)
    return true
  }

  const handleEnvVarChange = (v: string) => {
    const upper = v.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
    setEnvVarName(upper)
    validateEnvVar(upper)
  }

  const isValid = name.trim() && envVarName.trim() && ENV_VAR_PATTERN.test(envVarName.trim()) && (secret ? true : value.trim())

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid || isSubmitting) return

    let data: CreateSecretDTO | UpdateSecretDTO
    if (secret) {
      // Update — only include value if changed
      const updateData: UpdateSecretDTO = {
        name: name.trim(),
        description: description.trim(),
        env_var_name: envVarName.trim()
      }
      if (value.trim()) {
        updateData.value = value.trim()
      }
      data = updateData
    } else {
      // Create
      data = {
        name: name.trim(),
        description: description.trim(),
        env_var_name: envVarName.trim(),
        value: value.trim()
      }
    }

    setIsSubmitting(true)
    try {
      // Re-review (P2): only close on an actual success — a save that fails
      // (most commonly: safeStorage unavailable) must leave the dialog open,
      // with the user's input intact, next to the error.
      const ok = await onSubmit(data)
      if (ok) onClose()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{secret ? 'Edit Secret' : 'New Secret'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Production Database URL"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="secret-description">Description</Label>
              <Textarea
                id="secret-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="PostgreSQL connection string for the production database"
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="secret-env-var">Environment Variable</Label>
              <Input
                id="secret-env-var"
                value={envVarName}
                onChange={(e) => handleEnvVarChange(e.target.value)}
                placeholder="DATABASE_URL"
                className="font-mono text-sm"
                required
              />
              {envVarError ? (
                <p className="text-xs text-destructive">{envVarError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The environment variable name agents will use to access this secret
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="secret-value">
                {secret ? 'Value (leave empty to keep current)' : 'Value'}
              </Label>
              <Input
                id="secret-value"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={secret ? '••••••••' : 'Enter secret value...'}
                required={!secret}
              />
              <p className="text-xs text-muted-foreground">
                Encrypted at rest. Never sent to the renderer or agent process.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!isValid || isSubmitting}>
                {isSubmitting ? 'Saving…' : secret ? 'Save' : 'Add'}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
