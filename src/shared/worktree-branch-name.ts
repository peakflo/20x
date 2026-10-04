export const WORKTREE_BRANCH_MODE_KEY = 'worktree_branch_mode'
export const WORKTREE_BRANCH_PREFIX_KEY = 'worktree_branch_prefix'
export const WORKTREE_BRANCH_TEMPLATE_KEY = 'worktree_branch_template'

export type WorktreeBranchMode = 'prefix' | 'type-title' | 'ai' | 'template'

export interface BranchTask {
  id: string
  title: string
  description?: string
  type?: string
  labels?: string[]
  created_at?: string
}

export interface BranchNamingSettings {
  mode?: string | null
  prefix?: string | null
  template?: string | null
}

const MAX_BRANCH_LENGTH = 100

export function branchType(task: BranchTask): string {
  const terms = [task.type, ...(task.labels ?? [])].filter(Boolean).join(' ').toLowerCase()
  if (/\b(bug|fix|defect|hotfix)\b/.test(terms)) return 'fix'
  if (/\b(feature|feat|enhancement)\b/.test(terms)) return 'feat'
  return 'chore'
}

export function branchSlug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task'
}

export function sanitizeBranchName(value: string): string {
  const segments = value.toLowerCase().split('/').map((segment) => segment
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, ''))
    .filter(Boolean)
  const result = segments.join('/').slice(0, MAX_BRANCH_LENGTH).replace(/[./_-]+$/g, '')
  return result && result !== 'head' ? result : 'task'
}

export function shortTaskId(id: string): string {
  return branchSlug(id).slice(-8)
}

export function generateBranchName(task: BranchTask, settings: BranchNamingSettings, proposal?: string): string {
  const type = branchType(task)
  const slug = branchSlug(task.title).slice(0, 60)
  const shortId = shortTaskId(task.id)
  const date = (task.created_at || new Date().toISOString()).slice(0, 10)
  let raw: string
  switch (settings.mode) {
    case 'type-title':
      raw = `${type}/${slug}-${shortId}`
      break
    case 'ai':
      raw = proposal?.trim() || `${type}/${slug}-${shortId}`
      break
    case 'template':
      raw = (settings.template?.trim() || 'task/{id}').replace(/\{(type|slug|id|shortId|date)\}/g, (_, key: string) => ({ type, slug, id: task.id, shortId, date })[key as 'type'])
      break
    default:
      raw = `${settings.prefix === undefined || settings.prefix === null ? 'task' : settings.prefix.replace(/\/+$/g, '')}/${task.id}`
  }
  return sanitizeBranchName(raw)
}

export function withBranchSuffix(name: string, suffix: string): string {
  const cleanSuffix = branchSlug(suffix)
  return sanitizeBranchName(`${name.slice(0, MAX_BRANCH_LENGTH - cleanSuffix.length - 1).replace(/[./_-]+$/g, '')}-${cleanSuffix}`)
}
