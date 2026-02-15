import { useState, useEffect } from 'react'
import { Trash2, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import { Badge } from '@/components/ui/Badge'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel
} from '@/components/ui/AlertDialog'
import { useSkillStore } from '@/stores/skill-store'
import { formatRelativeDate } from '@/lib/utils'
import type { Skill } from '@/types'

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function SkillWorkspace() {
  const { skills, selectedSkillId, updateSkill, deleteSkill, selectSkill } = useSkillStore()
  const skill = skills.find((s) => s.id === selectedSkillId)

  if (!skill) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center space-y-2">
          <BookOpen className="h-10 w-10 mx-auto opacity-40" />
          <p className="text-sm">Select a skill to view or edit</p>
        </div>
      </div>
    )
  }

  return <SkillEditor key={skill.id} skill={skill} onUpdate={updateSkill} onDelete={deleteSkill} onDeselect={() => selectSkill(null)} />
}

function SkillEditor({ skill, onUpdate, onDelete, onDeselect }: {
  skill: Skill
  onUpdate: (id: string, data: { name?: string; description?: string; content?: string; confidence?: number; tags?: string[] }) => Promise<Skill | null>
  onDelete: (id: string) => Promise<boolean>
  onDeselect: () => void
}) {
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [confidence, setConfidence] = useState(skill.confidence)
  const [tagsInput, setTagsInput] = useState(skill.tags.join(', '))
  const [content, setContent] = useState(skill.content)
  const [showDelete, setShowDelete] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  useEffect(() => {
    setName(skill.name)
    setDescription(skill.description)
    setConfidence(skill.confidence)
    setTagsInput(skill.tags.join(', '))
    setContent(skill.content)
    setNameError(null)
  }, [skill.id])

  const isDirty = name !== skill.name ||
                  description !== skill.description ||
                  confidence !== skill.confidence ||
                  tagsInput !== skill.tags.join(', ') ||
                  content !== skill.content

  const handleSave = async () => {
    if (!NAME_PATTERN.test(name)) {
      setNameError('Must be lowercase with hyphens (e.g. my-skill)')
      return
    }
    if (!description.trim() || description.length > 1024) {
      return
    }
    setNameError(null)

    const data: { name?: string; description?: string; content?: string; confidence?: number; tags?: string[] } = {}
    if (name !== skill.name) data.name = name
    if (description !== skill.description) data.description = description
    if (confidence !== skill.confidence) data.confidence = confidence

    // Parse tags from comma-separated input
    const newTags = tagsInput.split(',').map(t => t.trim()).filter(t => t.length > 0)
    if (tagsInput !== skill.tags.join(', ')) data.tags = newTags

    if (content !== skill.content) data.content = content

    if (Object.keys(data).length > 0) {
      await onUpdate(skill.id, data)
    }
  }

  const handleDelete = async () => {
    await onDelete(skill.id)
    onDeselect()
    setShowDelete(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <Badge variant="purple">v{skill.version}</Badge>
          <span className="text-xs text-muted-foreground">{formatRelativeDate(skill.updated_at)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => setShowDelete(true)}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8 space-y-5">
          {/* Read-only Metadata */}
          <div className="grid grid-cols-2 gap-4 p-4 rounded-lg bg-accent/50">
            <div>
              <Label className="text-xs text-muted-foreground">Uses</Label>
              <p className="text-sm font-medium">{skill.uses}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Last Used</Label>
              <p className="text-sm font-medium">{skill.last_used ? formatRelativeDate(skill.last_used) : 'Never'}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))
                setNameError(null)
              }}
              placeholder="my-skill-name"
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of when this skill should be used..."
              rows={2}
              maxLength={1024}
            />
            <p className="text-[10px] text-muted-foreground text-right">{description.length}/1024</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-confidence">Confidence (0.0 - 1.0)</Label>
            <Input
              id="skill-confidence"
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={confidence}
              onChange={(e) => {
                const val = parseFloat(e.target.value)
                if (!isNaN(val) && val >= 0 && val <= 1) {
                  setConfidence(val)
                }
              }}
            />
            <p className="text-[10px] text-muted-foreground">{Math.round(confidence * 100)}%</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-tags">Tags (comma-separated)</Label>
            <Input
              id="skill-tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="api, database, authentication"
            />
            <p className="text-[10px] text-muted-foreground">Separate tags with commas</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-content">Content (Markdown)</Label>
            <Textarea
              id="skill-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Skill instructions in markdown..."
              rows={16}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={!isDirty || !name.trim() || !description.trim() || !content.trim()}>
              Save
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{skill.name}&rdquo;? This skill will no longer be available to agents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
