import { useEffect } from 'react'
import { Checkbox } from '@/components/ui/Checkbox'
import { useSkillStore } from '@/stores/skill-store'

interface SkillSelectorProps {
  /** undefined = all skills, string[] = specific skill IDs */
  selectedIds: string[] | undefined
  onChange: (ids: string[] | undefined) => void
}

export function SkillSelector({ selectedIds, onChange }: SkillSelectorProps) {
  const { skills, fetchSkills } = useSkillStore()

  useEffect(() => {
    fetchSkills()
  }, [])

  const isAll = selectedIds === undefined

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-border cursor-pointer hover:bg-accent/50">
        <Checkbox
          checked={isAll}
          onCheckedChange={(checked) => {
            onChange(checked ? undefined : [])
          }}
        />
        <span className="text-sm">All Skills</span>
      </label>

      {!isAll && skills.length > 0 && (
        <div className="space-y-0.5 pl-2">
          {skills.map((skill) => {
            const isChecked = selectedIds.includes(skill.id)
            return (
              <label key={skill.id} className="flex items-center gap-2.5 px-3 py-1.5 rounded-md cursor-pointer hover:bg-accent/50">
                <Checkbox
                  checked={isChecked}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      onChange([...selectedIds, skill.id])
                    } else {
                      onChange(selectedIds.filter((id) => id !== skill.id))
                    }
                  }}
                />
                <div className="min-w-0 flex-1">
                  <span className="text-sm">{skill.name}</span>
                  {skill.description && (
                    <p className="text-[10px] text-muted-foreground truncate">{skill.description}</p>
                  )}
                </div>
              </label>
            )
          })}
        </div>
      )}

      {!isAll && skills.length === 0 && (
        <p className="text-xs text-muted-foreground px-3 py-1">
          No skills created yet. Add skills from the Skills tab.
        </p>
      )}
    </div>
  )
}
