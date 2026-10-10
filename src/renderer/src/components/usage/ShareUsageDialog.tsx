import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/Dialog'
import { VisuallyHidden } from '@/components/ui/VisuallyHidden'
import { cn } from '@/lib/utils'
import { usageApi } from '@/lib/ipc-client'
import { waitForFonts } from '@/lib/wait-for-fonts'
import {
  renderToCanvas,
  type UsageCardShape,
  type UsageCardSummary,
  type UsageCardTheme
} from '@shared/usage-card'

const SHAPES: Array<{ value: UsageCardShape; label: string }> = [
  { value: 'wide', label: 'Wide' },
  { value: 'square', label: 'Square' },
  { value: 'tall', label: 'Tall' }
]
const THEMES: Array<{ value: UsageCardTheme; label: string }> = [
  { value: 'azure', label: 'Azure' },
  { value: 'ink', label: 'Ink' },
  { value: 'paper', label: 'Paper' }
]

interface SegmentedControlProps<T extends string> {
  label: string
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}

function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <div className="grid grid-flow-col auto-cols-fr gap-0.5 rounded-lg bg-muted p-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
              value === opt.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

interface ShareUsageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: UsageCardSummary | null
  periodDaysLabel: string
  name: string
  onNameChange: (name: string) => void
}

/** Share dialog: live preview (left) + shape/colour/name options and export actions (right) — matches the approved mock's layout. */
export function ShareUsageDialog({ open, onOpenChange, summary, periodDaysLabel, name, onNameChange }: ShareUsageDialogProps) {
  const [shape, setShape] = useState<UsageCardShape>('wide')
  const [theme, setTheme] = useState<UsageCardTheme>('azure')
  const [status, setStatus] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const blobRef = useRef<Blob | null>(null)

  const renderPreview = useCallback(() => {
    if (!summary) return
    const canvas = document.createElement('canvas')
    void waitForFonts().then(() => {
      renderToCanvas(canvas, shape, summary, { theme, name }, 1)
      try {
        setPreviewUrl(canvas.toDataURL('image/png'))
      } catch {
        // No real 2D canvas support (e.g. a non-browser test environment) — nothing to preview.
      }
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((blob) => { blobRef.current = blob }, 'image/png')
      }
    })
  }, [summary, shape, theme, name])

  useEffect(() => {
    if (!open) return
    setStatus('')
    renderPreview()
  }, [open, renderPreview])

  const defaultFileName = `20x-usage-${periodDaysLabel}-${shape}.png`

  const handleCopy = async (): Promise<void> => {
    if (!blobRef.current) return
    try {
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobRef.current })])
        setStatus('Image copied. Paste it anywhere.')
        return
      }
      throw new Error('Clipboard API unavailable')
    } catch {
      // Fall back to the main process, which uses Electron's own clipboard module.
      try {
        const bytes = await blobRef.current.arrayBuffer()
        const result = await usageApi.copyImageToClipboard(bytes)
        setStatus(result.success ? 'Image copied. Paste it anywhere.' : 'Could not copy the image.')
      } catch {
        setStatus('Could not copy the image.')
      }
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!blobRef.current) return
    try {
      const bytes = await blobRef.current.arrayBuffer()
      const result = await usageApi.saveImage(bytes, defaultFileName)
      setStatus(result.saved ? 'Saved.' : 'Save canceled.')
    } catch {
      setStatus('Could not save the image.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <VisuallyHidden>
          <DialogTitle>Share your usage</DialogTitle>
          <DialogDescription>Export a shareable image of your usage multiplier card.</DialogDescription>
        </VisuallyHidden>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_280px]">
          <div className="bg-[#101010] p-6 flex items-center justify-center min-h-[320px]">
            {previewUrl ? (
              <img src={previewUrl} alt="Preview of the share image" className="max-w-full max-h-[62vh] rounded-xl shadow-xl" />
            ) : (
              <div className="text-xs text-white/50">Generating preview…</div>
            )}
          </div>
          <div className="p-5 flex flex-col gap-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">Share your usage</h3>
              <p className="text-xs text-muted-foreground mt-1">The image is made on your computer. Nothing is uploaded.</p>
            </div>

            <SegmentedControl label="Shape" options={SHAPES} value={shape} onChange={setShape} />
            <SegmentedControl label="Colour" options={THEMES} value={theme} onChange={setTheme} />

            <div className="space-y-1.5">
              <label htmlFor="usage-card-name" className="block text-xs text-muted-foreground">Name on the card</label>
              <input
                id="usage-card-name"
                type="text"
                maxLength={28}
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                className="w-full rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm text-foreground"
              />
            </div>

            <div className="mt-auto flex flex-col gap-2">
              <div className="text-xs text-muted-foreground min-h-[18px]" aria-live="polite">{status}</div>
              <button
                type="button"
                onClick={() => void handleCopy()}
                disabled={!previewUrl}
                className="rounded-xl bg-primary px-3.5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Copy image
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!previewUrl}
                className="rounded-xl border border-border px-3.5 py-2.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
              >
                Save PNG
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
