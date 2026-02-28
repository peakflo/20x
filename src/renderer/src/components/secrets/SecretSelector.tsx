import { useEffect } from 'react'
import { Checkbox } from '@/components/ui/Checkbox'
import { useSecretStore } from '@/stores/secret-store'

interface SecretSelectorProps {
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

export function SecretSelector({ selectedIds, onChange }: SecretSelectorProps) {
  const { secrets, fetchSecrets } = useSecretStore()

  useEffect(() => {
    fetchSecrets()
  }, [])

  if (secrets.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-3 py-1">
        No secrets created yet. Add secrets in Settings &rarr; Secrets.
      </p>
    )
  }

  return (
    <div className="space-y-0.5">
      {secrets.map((secret) => {
        const isChecked = selectedIds.includes(secret.id)
        return (
          <label key={secret.id} className="flex items-center gap-2.5 px-3 py-1.5 rounded-md cursor-pointer hover:bg-accent/50">
            <Checkbox
              checked={isChecked}
              onCheckedChange={(checked) => {
                if (checked) {
                  onChange([...selectedIds, secret.id])
                } else {
                  onChange(selectedIds.filter((id) => id !== secret.id))
                }
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm">{secret.name}</span>
                <code className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                  ${secret.env_var_name}
                </code>
              </div>
              {secret.description && (
                <p className="text-[10px] text-muted-foreground break-words">{secret.description}</p>
              )}
            </div>
          </label>
        )
      })}
    </div>
  )
}
