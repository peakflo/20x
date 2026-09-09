import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseManager } from './database'
import type { FactoryDefinition, FactoryProposal } from '../shared/responsibilities'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function required(value: unknown, label: string, limit = 12000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} is required (maximum ${limit} characters).`)
  return value.trim()
}

/** Saved guides and exact pending confirmations; execution remains in ResponsibilityManager. */
export class Factories {
  constructor(private readonly db: DatabaseManager) {}

  private rows<T>(prefix: string): T[] {
    return (this.db.db.prepare('SELECT value FROM settings WHERE key LIKE ? ORDER BY key').all(`${prefix}:%`) as { value: string }[]).map(r => JSON.parse(r.value))
  }
  list(projectId?: string): FactoryDefinition[] { return this.rows<FactoryDefinition>('factory').filter(f => !projectId || f.projectId === projectId) }
  proposals(projectId?: string): FactoryProposal[] { return this.rows<FactoryProposal>('factory-proposal').filter(p => !projectId || p.definition.projectId === projectId) }
  read(id: unknown, projectId: string): FactoryDefinition {
    const value = this.db.getSetting(`factory:${required(id, 'Factory ID', 160)}`)
    const f: FactoryDefinition | undefined = value ? JSON.parse(value) : undefined
    if (!f || f.projectId !== projectId) throw new Error('Factory not found in this project. Choose a current Factory or use ordinary work.')
    return f
  }
  private clearProposals(target: string): void {
    for (const p of this.proposals().filter(p => p.definition.id === target)) this.db.deleteSetting(`factory-proposal:${p.id}`)
  }
  propose(projectId: string, provenance: string, args: Record<string, unknown>, operation: 'save' | 'delete' = 'save'): FactoryProposal {
    const existing = args.factoryId ? this.read(args.factoryId, projectId) : undefined
    if (operation === 'delete' && !existing) throw new Error('Choose an exact Factory to delete.')
    const name = operation === 'delete' ? existing!.name : required(args.name, 'Factory name', 160)
    const named = this.list(projectId).find(f => f.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (named && existing && named.id !== existing.id) throw new Error('Another Factory already has this name in this project.')
    const target = existing ?? named
    if (!target && this.list(projectId).length >= 100) throw new Error('This project has 100 Factories. Remove an unused guide before adding another.')
    const pending = this.proposals(projectId)
    if (pending.length >= 100 && !pending.some(p => p.definition.id === target?.id || p.definition.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('Review the existing Factory previews before creating another.')
    const at = new Date().toISOString()
    const definition: FactoryDefinition = operation === 'delete' ? existing! : {
      id: target?.id ?? randomUUID(), projectId, name,
      diagram: required(args.diagram, 'Factory diagram'), guide: required(args.guide, 'Factory instructions'),
      provenance, createdAt: target?.createdAt ?? at, updatedAt: at
    }
    const proposal: FactoryProposal = { id: randomUUID(), definition, operation, replacesDigest: target ? hash(target) : null }
    this.db.db.transaction(() => {
      // Pending drafts with the same new name share a target, too.
      for (const p of this.proposals(projectId).filter(p => p.definition.name.toLocaleLowerCase() === name.toLocaleLowerCase())) this.db.deleteSetting(`factory-proposal:${p.id}`)
      this.clearProposals(definition.id)
      this.db.setSetting(`factory-proposal:${proposal.id}`, JSON.stringify(proposal))
    })()
    return proposal
  }
  decide(proposalId: string, approve: boolean): void {
    required(proposalId, 'Proposal ID', 160)
    const raw = this.db.getSetting(`factory-proposal:${proposalId}`)
    if (!raw) throw new Error('This Factory preview expired. Read the current draft first.')
    const p: FactoryProposal = JSON.parse(raw)
    this.db.db.transaction(() => {
      if (approve) {
        const current = this.db.getSetting(`factory:${p.definition.id}`)
        if ((current ? hash(JSON.parse(current)) : null) !== p.replacesDigest) throw new Error('The Factory changed. Request a fresh preview before confirming.')
        if (p.operation === 'delete') this.db.deleteSetting(`factory:${p.definition.id}`)
        else {
          if (!current && this.list(p.definition.projectId).length >= 100) throw new Error('This project has 100 Factories. Remove an unused guide before saving another.')
          const named = this.list(p.definition.projectId).find(f => f.name.toLocaleLowerCase() === p.definition.name.toLocaleLowerCase() && f.id !== p.definition.id)
          if (named) throw new Error('A Factory with this name was saved. Request a fresh preview.')
          this.db.setSetting(`factory:${p.definition.id}`, JSON.stringify({ ...p.definition, provenance: `Engineer confirmed proposal ${p.id}; ${p.definition.provenance}` }))
        }
      }
      this.clearProposals(p.definition.id)
    })()
  }
}
