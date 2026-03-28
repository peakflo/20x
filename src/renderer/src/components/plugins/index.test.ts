import { describe, it, expect } from 'vitest'
import { PLUGIN_FORMS, getPluginForm } from './index'

describe('Plugin Forms Registry', () => {
  it('includes youtrack in PLUGIN_FORMS', () => {
    expect(PLUGIN_FORMS).toHaveProperty('youtrack')
    expect(typeof PLUGIN_FORMS.youtrack).toBe('function')
  })

  it('getPluginForm returns YouTrackConfigForm for youtrack', () => {
    const form = getPluginForm('youtrack')
    expect(form).not.toBeNull()
    expect(form).toBe(PLUGIN_FORMS.youtrack)
  })

  it('includes all expected plugins', () => {
    const expectedPlugins = ['linear', 'hubspot', 'peakflo', 'github-issues', 'notion', 'youtrack']
    for (const pluginId of expectedPlugins) {
      expect(PLUGIN_FORMS).toHaveProperty(pluginId)
    }
  })

  it('returns null for unknown plugin', () => {
    expect(getPluginForm('unknown-plugin')).toBeNull()
  })
})
