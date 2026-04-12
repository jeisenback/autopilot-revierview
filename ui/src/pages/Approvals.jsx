import { useApprovals, useResolveApproval } from '@/hooks/useApprovals'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { CheckCircle } from 'lucide-react'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

function timeUntil(expiresAt) {
  if (!expiresAt) return null
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'Expired'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function ApprovalCard({ approval }) {
  const resolve = useResolveApproval()
  const expiresSoon = approval.expires_at && (new Date(approval.expires_at).getTime() - Date.now()) < SIX_HOURS_MS

  function handleResolve(action) {
    resolve.mutate({ id: approval.id, action }, {
      onSuccess: () => toast.success(action === 'approved' ? 'Approved' : 'Denied'),
    })
  }

  return (
    <div className="py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium">{approval.task_title}</span>
            {approval.estimated_cost > 0 && (
              <span className="text-xs text-muted-foreground">~${approval.estimated_cost}</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            {approval.expires_at && (
              <span className="flex items-center gap-1">
                Expires in {timeUntil(approval.expires_at)}
                {expiresSoon && <span className="text-yellow-600 font-medium">⚠</span>}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" onClick={() => handleResolve('approved')} disabled={resolve.isPending}>
            Approve
          </Button>
          <Button size="sm" variant="outline" className="text-destructive"
            onClick={() => handleResolve('denied')} disabled={resolve.isPending}>
            Deny
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function Approvals() {
  const { data: approvals = [], isLoading, error } = useApprovals()

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>
  if (error) return <div className="text-destructive text-sm">Error: {error.message}</div>

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2 mb-6">
        <h1 className="text-xl font-semibold">Pending Approvals</h1>
        {approvals.length > 0 && (
          <Badge variant="secondary">{approvals.length}</Badge>
        )}
      </div>

      {approvals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <CheckCircle className="w-10 h-10 opacity-30" />
          <p className="text-sm">No pending approvals.</p>
        </div>
      ) : (
        <div className="divide-y">
          {approvals.map(a => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      )}
    </div>
  )
}
