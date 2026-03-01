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
  onSubmit: (data: CreateSecretDTO | UpdateSecretDTO) => void
}

const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export function SecretFormDialog({ secret, open, onClose, onSubmit }: SecretFormDialogProps) {
  const [name, setName] = useState(secret?.name ?? '')
  const [description, setDescription] = useState(secret?.description ?? '')
  const [envVarName, setEnvVarName] = useState(secret?.env_var_name ?? '')
  const [value, setValue] = useState('')
  const [envVarError, setEnvVarError] = useState<string | null>(null)

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return

    if (secret) {
      // Update — only include value if changed
      const data: UpdateSecretDTO = {
        name: name.trim(),
        description: description.trim(),
        env_var_name: envVarName.trim()
      }
      if (value.trim()) {
        data.value = value.trim()
      }
      onSubmit(data)
    } else {
      // Create
      const data: CreateSecretDTO = {
        name: name.trim(),
        description: description.trim(),
        env_var_name: envVarName.trim(),
        value: value.trim()
      }
      onSubmit(data)
    }
    onClose()
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
              <Button type="submit" size="sm" disabled={!isValid}>
                {secret ? 'Save' : 'Add'}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
