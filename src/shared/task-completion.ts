import { PluginActionId } from './constants'

/** Use the same action for the completion preview and the source write. */
export function getTaskCompletionAction(outputFields: readonly unknown[]): string {
  const field = outputFields.find((field): field is { id: string; value?: unknown } =>
    typeof field === 'object' && field !== null && 'id' in field && field.id === 'action'
  )
  return field?.value ? String(field.value) : PluginActionId.Complete
}

export function getSourceCompletionDescription(task: {
  source_id: string | null
  source: string
  output_fields: readonly unknown[]
}, sourceName?: string): string | undefined {
  if (!task.source_id) return undefined
  const name = sourceName?.trim() || task.source?.trim() || 'the task source'
  return `Action at ${name}: ${getTaskCompletionAction(task.output_fields)}. Completion sends this action and the task outputs to the source.`
}
