import { PluginActionId } from './constants'

/** Use the same action for the completion preview and the source write. */
export function getTaskCompletionAction(outputFields: readonly unknown[]): string {
  const field = outputFields.find((field): field is { id: string; value?: unknown } =>
    typeof field === 'object' && field !== null && 'id' in field && field.id === 'action'
  )
  return field?.value ? String(field.value) : PluginActionId.Complete
}

/** The task label identifies the source system; a connection can have a custom name. */
export function getTaskSourceName(task: { source: string }, connectionName?: string): string {
  return task.source?.trim() || connectionName?.trim() || 'the task source'
}

export function getSourceCompletionDescription(task: {
  source_id: string | null
  source: string
  output_fields: readonly unknown[]
}, sourceName?: string): string | undefined {
  if (!task.source_id) return undefined
  const name = getTaskSourceName(task, sourceName)
  return `Action at ${name}: ${getTaskCompletionAction(task.output_fields)}. Completion sends this action and the task outputs to the source.`
}
