import { Badge } from '@/components/ui/Badge'
import { formatRelativeDate } from '@/lib/utils'
import type { Skill } from '@/types'

interface SkillListProps {
  skills: Skill[]
  selectedSkillId: string | null
  onSelectSkill: (id: string) => void
}

export function SkillList({ skills, selectedSkillId, onSelectSkill }: SkillListProps) {
  if (skills.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        No skills yet. Create one to get started.
      </div>
    )
  }

  return (
    <div className="space-y-0.5 px-2">
      {skills.map((skill) => (
        <button
          key={skill.id}
          onClick={() => onSelectSkill(skill.id)}
          className={`w-full text-left rounded-md px-3 py-2.5 cursor-pointer transition-colors ${
            selectedSkillId === skill.id
              ? 'bg-accent'
              : 'hover:bg-accent/50'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate flex-1">{skill.name}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground">{Math.round(skill.confidence * 100)}%</span>
              <Badge className="shrink-0">v{skill.version}</Badge>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{skill.description}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-[10px] text-muted-foreground/70">{formatRelativeDate(skill.updated_at)}</p>
            {skill.uses > 0 && (
              <span className="text-[10px] text-muted-foreground/70">• {skill.uses} uses</span>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}
