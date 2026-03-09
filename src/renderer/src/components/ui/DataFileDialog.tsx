import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { DataFilePreview } from '@/components/ui/DataFilePreview'
import { Table2 } from 'lucide-react'

interface DataFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filePath: string
}

export function DataFileDialog({ open, onOpenChange, filePath }: DataFileDialogProps) {
  const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || filePath

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] max-h-[90vh] w-[95vw]">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <Table2 className="h-4 w-4 text-primary" />
              {fileName}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="px-2 pb-2 overflow-hidden flex-1 min-h-0">
          <DataFilePreview
            filePath={filePath}
            maxRows={5000}
            compact={false}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
