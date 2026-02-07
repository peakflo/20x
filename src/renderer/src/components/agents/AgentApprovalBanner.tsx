import { useState } from 'react'
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import type { AgentApprovalRequest } from '@/types/electron'

interface AgentApprovalBannerProps {
  request: AgentApprovalRequest | null
  onApprove: (message?: string) => void
  onReject: (message?: string) => void
}

export function AgentApprovalBanner({ request, onApprove, onReject }: AgentApprovalBannerProps) {
  const [message, setMessage] = useState('')

  if (!request) return null

  return (
    <div className="fixed inset-x-0 top-0 z-50 bg-yellow-500/10 border-b border-yellow-500/20">
      <div className="max-w-4xl mx-auto px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-yellow-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-foreground">
              Agent needs your approval
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              The agent wants to: <span className="text-foreground font-medium">{request.description}</span>
            </p>
            
            <div className="mt-3">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Optional: Add a message for the agent..."
                rows={2}
                className="text-sm bg-background/50"
              />
            </div>

            <div className="flex items-center gap-2 mt-3">
              <Button
                size="sm"
                onClick={() => onApprove(message || undefined)}
                className="bg-green-600 hover:bg-green-700"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onReject(message || undefined)}
                className="border-red-500/50 text-red-400 hover:bg-red-500/10"
              >
                <XCircle className="h-3.5 w-3.5 mr-1.5" />
                Reject
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
