import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SettingsSection } from './SettingsSection'

afterEach(cleanup)

describe('SettingsSection', () => {
  it('renders the title and children', () => {
    render(
      <SettingsSection title="General">
        <button>Child control</button>
      </SettingsSection>
    )

    expect(screen.getByRole('heading', { name: 'General' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Child control' })).toBeDefined()
  })

  it('renders the description when provided', () => {
    render(
      <SettingsSection title="General" description="Tweak your settings">
        <div>content</div>
      </SettingsSection>
    )

    expect(screen.getByText('Tweak your settings')).toBeDefined()
  })

  it('omits the description when not provided', () => {
    render(
      <SettingsSection title="General">
        <div>content</div>
      </SettingsSection>
    )

    expect(screen.queryByText('Tweak your settings')).toBeNull()
  })

  it('renders multiple children', () => {
    render(
      <SettingsSection title="General">
        <div>Alpha</div>
        <div>Beta</div>
      </SettingsSection>
    )

    expect(screen.getByText('Alpha')).toBeDefined()
    expect(screen.getByText('Beta')).toBeDefined()
  })
})
