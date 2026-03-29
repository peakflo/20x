import {
  Bot,
  CheckCircle2,
  Cpu,
  PlusCircle
} from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard-store'

function formatPercent(value: number | null): string {
  if (value === null || value === undefined) return '--'
  return `${value.toFixed(1)}%`
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString()
}

interface StatCardProps {
  title: string
  value: string
  description?: string
  icon: React.ElementType
  loading?: boolean
  accent?: string
}

function StatCard({ title, value, description, icon: Icon, loading, accent }: StatCardProps) {
  return (
    <div className="relative rounded-lg border border-border/50 bg-[#161b22] p-4 overflow-hidden">
      {accent && (
        <div className="absolute top-0 left-0 w-full h-0.5" style={{ backgroundColor: accent }} />
      )}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <Icon className="h-4 w-4" style={accent ? { color: accent } : { color: 'var(--muted-foreground)' }} />
      </div>
      {loading ? (
        <div className="h-7 w-20 rounded bg-muted/50 animate-pulse" />
      ) : (
        <>
          <div className="text-2xl font-bold tracking-tight">{value}</div>
          {description && (
            <p className="text-[11px] text-muted-foreground mt-1 truncate">{description}</p>
          )}
        </>
      )}
    </div>
  )
}

export function StatsSection() {
  const { stats, localStats, statsLoading } = useDashboardStore()

  // Use cloud stats when available, otherwise fall back to local stats
  const effectiveStats = stats || localStats

  return (
    <section>
      <h2 className="text-sm font-semibold mb-3">Stats Overview</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          title="AI Autonomy"
          value={formatPercent(effectiveStats?.aiAutonomyRate ?? null)}
          description={
            effectiveStats
              ? `${formatNumber(effectiveStats.autonomousTasksCompleted)} autonomous`
              : 'Tasks without human review'
          }
          icon={Bot}
          loading={statsLoading}
          accent="#6d28d9"
        />
        <StatCard
          title="Agent Success"
          value={formatPercent(effectiveStats?.agentSuccessRate ?? null)}
          description={`${formatNumber(effectiveStats?.totalAgentRuns)} total runs`}
          icon={Cpu}
          loading={statsLoading}
          accent="#059669"
        />
        <StatCard
          title="Tasks Created"
          value={formatNumber(effectiveStats?.tasksCreatedInWindow)}
          description={`${formatNumber(effectiveStats?.totalTasks)} total`}
          icon={PlusCircle}
          loading={statsLoading}
        />
        <StatCard
          title="Completed"
          value={formatNumber(effectiveStats?.tasksCompletedInWindow)}
          description="In selected window"
          icon={CheckCircle2}
          loading={statsLoading}
        />
      </div>
    </section>
  )
}
