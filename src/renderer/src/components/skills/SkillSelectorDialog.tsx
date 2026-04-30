import { useState, useEffect, useMemo } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { useSkillStore } from '@/stores/skill-store'

interface SkillSelectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSkillIds: string[]
  onConfirm: (skillIds: string[]) => void
}

export function SkillSelectorDialog({ open, onOpenChange, initialSkillIds, onConfirm }: SkillSelectorDialogProps) {
  const { skills, fetchSkills } = useSkillStore()
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSkillIds))
  const [search, setSearch] = useState('')
  const initialSkillIdsKey = useMemo(() => [...initialSkillIds].sort().join('\0'), [initialSkillIds])

  useEffect(() => {
    if (!open) return

    fetchSkills()
    setSearch('')
  }, [open, fetchSkills])

  useEffect(() => {
    if (!open) return

    setSelected((prev) => {
      const next = new Set(initialSkillIds)
      if (prev.size === next.size && Array.from(next).every((id) => prev.has(id))) {
        return prev
      }
      return next
    })
  }, [open, initialSkillIds, initialSkillIdsKey])

  const filtered = useMemo(() => {
    if (!search) return skills
    const q = search.toLowerCase()
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [skills, search])

  const toggleSkill = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleConfirm = () => {
    onConfirm(Array.from(selected))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Skills</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter skills..."
              className="w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
            />
          </div>

          {/* Skill list */}
          <div className="max-h-80 overflow-y-auto -mx-1 px-1 space-y-1">
            {filtered.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {search ? 'No matching skills' : 'No skills available. Add skills from the Skills tab.'}
              </div>
            ) : (
              filtered.map((skill) => (
                <label
                  key={skill.id}
                  className="flex items-start gap-3 rounded-md p-2.5 hover:bg-accent/50 cursor-pointer transition-colors"
                >
                  <Checkbox
                    checked={selected.has(skill.id)}
                    onCheckedChange={() => toggleSkill(skill.id)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{skill.name}</span>
                    {skill.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{skill.description}</p>
                    )}
                    {skill.tags.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {skill.tags.map((tag) => (
                          <span key={tag} className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-xs text-muted-foreground">
              {selected.size} skill{selected.size !== 1 ? 's' : ''} selected
            </span>
            <Button onClick={handleConfirm}>Confirm</Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
