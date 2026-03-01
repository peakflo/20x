import { useState, useEffect } from 'react'
import { Plus, Edit3, Trash2, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SettingsSection } from '../SettingsSection'
import { SecretFormDialog } from '../forms/SecretFormDialog'
import { useSecretStore } from '@/stores/secret-store'
import type { Secret, CreateSecretDTO, UpdateSecretDTO } from '@/types'

interface SecretDialogState {
  open: boolean
  secret?: Secret
}

export function SecretsSettings() {
  const { secrets, fetchSecrets, createSecret, updateSecret, deleteSecret } = useSecretStore()
  const [dialog, setDialog] = useState<SecretDialogState>({ open: false })

  useEffect(() => {
    fetchSecrets()
  }, [])

  const handleCreate = async (data: CreateSecretDTO | UpdateSecretDTO) => {
    await createSecret(data as CreateSecretDTO)
    setDialog({ open: false })
  }

  const handleUpdate = async (data: CreateSecretDTO | UpdateSecretDTO) => {
    if (dialog.secret) {
      await updateSecret(dialog.secret.id, data as UpdateSecretDTO)
      setDialog({ open: false })
    }
  }

  const handleDelete = async (id: string) => {
    if (confirm('Delete this secret? It will be removed from all agents.')) {
      await deleteSecret(id)
    }
  }

  return (
    <>
      <SettingsSection
        title="Secrets"
        description="Manage encrypted secrets that can be injected into agent environments"
      >
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {secrets.length} secret{secrets.length !== 1 ? 's' : ''} configured
          </p>
          <Button size="sm" onClick={() => setDialog({ open: true })}>
            <Plus className="h-3.5 w-3.5" />
            Add Secret
          </Button>
        </div>

        {secrets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-border rounded-lg">
            <KeyRound className="h-8 w-8 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-1">No secrets configured yet</p>
            <p className="text-xs text-muted-foreground mb-3">
              Secrets are encrypted at rest and securely injected into agent shell commands
            </p>
            <Button size="sm" onClick={() => setDialog({ open: true })}>
              <Plus className="h-3.5 w-3.5" />
              Add Your First Secret
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {secrets.map((secret) => (
              <div key={secret.id} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{secret.name}</span>
                      <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                        ${secret.env_var_name}
                      </code>
                    </div>
                    {secret.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {secret.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDialog({ open: true, secret })}
                      title="Edit"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(secret.id)}
                      className="text-destructive hover:text-destructive"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SecretFormDialog
        secret={dialog.secret}
        open={dialog.open}
        onClose={() => setDialog({ open: false })}
        onSubmit={dialog.secret ? handleUpdate : handleCreate}
      />
    </>
  )
}
