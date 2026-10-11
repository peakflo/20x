import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { usageApi } from '@/lib/ipc-client'
import type { CustomModelPrice } from '@shared/usage'

interface FormState {
  model: string
  inputPerMTok: string
  outputPerMTok: string
  cacheReadPerMTok: string
  cacheWritePerMTok: string
}

const EMPTY_FORM: FormState = { model: '', inputPerMTok: '', outputPerMTok: '', cacheReadPerMTok: '', cacheWritePerMTok: '' }

function formForPrice(price: CustomModelPrice): FormState {
  return {
    model: price.model,
    inputPerMTok: String(price.inputPerMTok),
    outputPerMTok: String(price.outputPerMTok),
    cacheReadPerMTok: price.cacheReadPerMTok != null ? String(price.cacheReadPerMTok) : '',
    cacheWritePerMTok: price.cacheWritePerMTok != null ? String(price.cacheWritePerMTok) : ''
  }
}

function parseOptional(value: string): number | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : Number(trimmed)
}

interface ModelPricesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefills the form with this model id when the dialog opens (e.g. from a "Set price" row action). */
  initialModel?: string | null
  onChanged?: (prices: CustomModelPrice[]) => void
}

/** Settings → Usage → "Model prices": add, edit and reset per-model custom prices used when the public rate table does not know a model. */
export function ModelPricesDialog({ open, onOpenChange, initialModel, onChanged }: ModelPricesDialogProps) {
  const [prices, setPrices] = useState<CustomModelPrice[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setForm(initialModel ? { ...EMPTY_FORM, model: initialModel } : EMPTY_FORM)
    void usageApi.listModelPrices().then(setPrices).catch(() => undefined)
  }, [open, initialModel])

  const handleSave = async (): Promise<void> => {
    const model = form.model.trim()
    const inputPerMTok = Number(form.inputPerMTok)
    const outputPerMTok = Number(form.outputPerMTok)
    if (!model) { setError('Enter a model id.'); return }
    if (!Number.isFinite(inputPerMTok) || inputPerMTok < 0 || !Number.isFinite(outputPerMTok) || outputPerMTok < 0) {
      setError('Input and output rates must be numbers ≥ 0.')
      return
    }
    const price: CustomModelPrice = {
      model,
      inputPerMTok,
      outputPerMTok,
      cacheReadPerMTok: parseOptional(form.cacheReadPerMTok) ?? null,
      cacheWritePerMTok: parseOptional(form.cacheWritePerMTok) ?? null
    }
    setSaving(true)
    setError(null)
    try {
      const next = await usageApi.setModelPrice(price)
      setPrices(next)
      onChanged?.(next)
      setForm(EMPTY_FORM)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async (model: string): Promise<void> => {
    const next = await usageApi.resetModelPrice(model)
    setPrices(next)
    onChanged?.(next)
    if (form.model === model) setForm(EMPTY_FORM)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Model prices</DialogTitle>
          <DialogDescription>
            Set a custom price for models the public rate table does not know, or override its price for one you
            use. Rates are USD per million tokens; a blank cache rate uses the input rate, 0 means free.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label htmlFor="price-model">Model id</Label>
              <Input
                id="price-model"
                placeholder="e.g. my-custom-model"
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="price-input">Input $/M tok</Label>
              <Input
                id="price-input"
                type="number"
                min={0}
                step="any"
                value={form.inputPerMTok}
                onChange={(e) => setForm((f) => ({ ...f, inputPerMTok: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="price-output">Output $/M tok</Label>
              <Input
                id="price-output"
                type="number"
                min={0}
                step="any"
                value={form.outputPerMTok}
                onChange={(e) => setForm((f) => ({ ...f, outputPerMTok: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="price-cache-read">Cache read $/M tok</Label>
              <Input
                id="price-cache-read"
                type="number"
                min={0}
                step="any"
                placeholder="= input"
                value={form.cacheReadPerMTok}
                onChange={(e) => setForm((f) => ({ ...f, cacheReadPerMTok: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="price-cache-write">Cache write $/M tok</Label>
              <Input
                id="price-cache-write"
                type="number"
                min={0}
                step="any"
                placeholder="= input"
                value={form.cacheWritePerMTok}
                onChange={(e) => setForm((f) => ({ ...f, cacheWritePerMTok: e.target.value }))}
              />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save price'}
          </Button>

          {prices.length > 0 && (
            <div className="rounded-lg border border-border bg-card overflow-hidden mt-2">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Model</th>
                    <th className="text-right font-medium px-3 py-2">Input</th>
                    <th className="text-right font-medium px-3 py-2">Output</th>
                    <th className="text-right font-medium px-3 py-2">Cache read</th>
                    <th className="text-right font-medium px-3 py-2">Cache write</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {prices.map((price) => (
                    <tr key={price.model} className="border-t border-border">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="font-medium text-foreground hover:underline text-left"
                          onClick={() => setForm(formForPrice(price))}
                        >
                          {price.model}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">${price.inputPerMTok}</td>
                      <td className="px-3 py-2 text-right tabular-nums">${price.outputPerMTok}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{price.cacheReadPerMTok ?? '= input'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{price.cacheWritePerMTok ?? '= input'}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          aria-label={`Reset price for ${price.model}`}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => void handleReset(price.model)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
