import { useState } from 'react'
import {
  Calculator,
  UserPlus,
  Package,
  CheckCircle2,
  ArrowRight
} from 'lucide-react'
import { useDashboardStore, type PresetupTemplate } from '@/stores/dashboard-store'
import { PresetupWizard } from './PresetupWizard'

const ICON_MAP: Record<string, React.ElementType> = {
  Calculator: Calculator,
  UserPlus: UserPlus
}

function getIcon(iconName: string): React.ElementType {
  return ICON_MAP[iconName] || Package
}

const CATEGORY_COLORS: Record<string, string> = {
  finance: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  sales: 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
}

function TemplateCard({
  template,
  onSetup
}: {
  template: PresetupTemplate
  onSetup: (template: PresetupTemplate) => void
}) {
  const Icon = getIcon(template.icon)
  const categoryColor =
    CATEGORY_COLORS[template.category] ||
    'bg-muted text-muted-foreground'

  if (template.isProvisioned) {
    return (
      <div className="rounded-lg border border-border/50 bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-green-500/10 p-2 shrink-0">
            <Icon className="h-5 w-5 text-green-600 dark:text-green-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium truncate">{template.name}</h3>
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
            </div>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {template.description}
            </p>
            <div className="mt-2 text-[11px] text-muted-foreground">
              {template.provisionedAt
                ? `Set up ${new Date(template.provisionedAt).toLocaleDateString()}`
                : 'Active'}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card p-4 transition-all hover:border-border hover:bg-secondary/30 group">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary/10 p-2 shrink-0">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium truncate">{template.name}</h3>
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${categoryColor}`}
            >
              {template.category}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {template.description}
          </p>
          <div className="mt-3">
            <button
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors cursor-pointer"
              onClick={() => onSetup(template)}
            >
              Set up
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function PresetupSection() {
  const { presetupTemplates, presetupLoading } = useDashboardStore()
  const [wizardTemplate, setWizardTemplate] = useState<PresetupTemplate | null>(null)

  if (presetupLoading) {
    return (
      <section>
        <h2 className="text-sm font-semibold mb-3">Get Started</h2>
        <div className="grid grid-cols-2 gap-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-lg border border-border/50 bg-muted/30"
            />
          ))}
        </div>
      </section>
    )
  }

  if (presetupTemplates.length === 0) {
    return null
  }

  return (
    <>
      <section>
        <h2 className="text-sm font-semibold mb-3">Get Started</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {presetupTemplates.map((template) => (
            <TemplateCard
              key={template.slug}
              template={template}
              onSetup={setWizardTemplate}
            />
          ))}
        </div>
      </section>

      {wizardTemplate && (
        <PresetupWizard
          template={wizardTemplate}
          onClose={() => setWizardTemplate(null)}
        />
      )}
    </>
  )
}
