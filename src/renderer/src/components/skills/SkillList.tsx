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

  // Sort by confidence descending by default
  const sortedSkills = [...skills].sort((a, b) => b.confidence - a.confidence)

  return (
    <div className="space-y-1.5 px-2">
      {sortedSkills.map((skill) => {
        const descFirstLine = skill.description.split('\n')[0]
        const confidencePercent = Math.round(skill.confidence * 100)

        return (
          <button
            key={skill.id}
            onClick={() => onSelectSkill(skill.id)}
            className={`w-full text-left rounded-lg px-3 py-3 cursor-pointer transition-colors border ${
              selectedSkillId === skill.id
                ? 'bg-accent border-border'
                : 'hover:bg-accent/50 border-transparent'
            }`}
          >
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <span className="text-sm font-medium">{skill.name}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Confidence bar */}
                <div className="flex items-center gap-1">
                  <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{ width: `${confidencePercent}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {skill.confidence.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mb-1.5 line-clamp-1">{descFirstLine}</p>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
              <span>Uses: {skill.uses}</span>
              <span>·</span>
              <span>Last: {skill.last_used ? formatRelativeDate(skill.last_used) : 'Never'}</span>
              {skill.tags.length > 0 && (
                <>
                  <span>·</span>
                  <span className="truncate">Tags: {skill.tags.join(', ')}</span>
                </>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
