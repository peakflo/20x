/**
 * Plugin Configuration Forms
 *
 * Maps plugin IDs to their custom configuration form components.
 * Each plugin can have its own unique UI, validation, and OAuth flow.
 */

import { LinearConfigForm } from './LinearConfigForm'
import { HubSpotConfigForm } from './HubSpotConfigForm'
import { PeakfloConfigForm } from './PeakfloConfigForm'
import type { PluginFormProps } from './PluginFormProps'

type PluginFormComponent = React.ComponentType<PluginFormProps>

/**
 * Registry of plugin-specific configuration forms
 */
export const PLUGIN_FORMS: Record<string, PluginFormComponent> = {
  linear: LinearConfigForm,
  hubspot: HubSpotConfigForm,
  peakflo: PeakfloConfigForm
}

/**
 * Get the configuration form component for a plugin
 */
export function getPluginForm(pluginId: string): PluginFormComponent | null {
  return PLUGIN_FORMS[pluginId] || null
}
