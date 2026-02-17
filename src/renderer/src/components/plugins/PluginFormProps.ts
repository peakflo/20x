/**
 * Common props for all plugin configuration forms
 */
export interface PluginFormProps {
  value: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
  sourceId?: string
  onRequestSave?: () => boolean // Returns true if save was triggered
}
