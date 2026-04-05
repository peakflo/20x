import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { getTemplateIcon } from './icon-map'
import type { PresetupTemplate } from '@/lib/presetup-api'
import { Workflow, Plug, Sparkles } from 'lucide-react'

interface PresetupTemplateCardProps {
  template: PresetupTemplate
  onSelect: (template: PresetupTemplate) => void
}

export function PresetupTemplateCard({ template, onSelect }: PresetupTemplateCardProps) {
  const Icon = getTemplateIcon(template.icon)
  const { workflows, integrations, skills } = template.definition

  const maxTags = 4
  const visibleTags = template.tags.slice(0, maxTags)
  const extraTagCount = template.tags.length - maxTags

  return (
    <div className="border border-border rounded-lg p-4 hover:border-primary/50 transition-colors bg-card">
      <div className="flex items-start gap-3 mb-3">
        <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{template.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{template.description}</p>
        </div>
      </div>

      {/* Resource chips */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {workflows.length > 0 && (
          <Badge variant="blue">
            <Workflow className="h-3 w-3 mr-1" />
            {workflows.length} workflow{workflows.length !== 1 ? 's' : ''}
          </Badge>
        )}
        {integrations.length > 0 && (
          <Badge variant="green">
            <Plug className="h-3 w-3 mr-1" />
            {integrations.length} integration{integrations.length !== 1 ? 's' : ''}
          </Badge>
        )}
        {skills.length > 0 && (
          <Badge variant="purple">
            <Sparkles className="h-3 w-3 mr-1" />
            {skills.length} skill{skills.length !== 1 ? 's' : ''}
          </Badge>
        )}
      </div>

      {/* Tags */}
      {visibleTags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {visibleTags.map((tag) => (
            <Badge key={tag} variant="default">
              {tag}
            </Badge>
          ))}
          {extraTagCount > 0 && (
            <Badge variant="default">+{extraTagCount} more</Badge>
          )}
        </div>
      )}

      <Button
        size="sm"
        className="w-full"
        onClick={() => onSelect(template)}
      >
        Get started
      </Button>
    </div>
  )
}
