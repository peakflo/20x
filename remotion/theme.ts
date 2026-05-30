/** Dark theme (used by Remotion for video rendering) */
export const theme = {
  background: '#181818',
  foreground: '#FFFFFF',
  card: '#1E1E1E',
  primary: '#339CFF',
  secondary: '#2A2A2A',
  muted: '#2A2A2A',
  mutedForeground: '#888888',
  accent: '#333333',
  border: '#333333',
  destructive: '#C06771',
  sidebar: '#181818',
  sidebarForeground: '#E4E8F0',
  sidebarBorder: '#333333',
  sidebarAccent: '#333333',
}

/** Light theme variant */
export const lightTheme = {
  background: '#FFFFFF',
  foreground: '#1A1C1F',
  card: '#FFFFFF',
  primary: '#339CFF',
  secondary: '#F3F4F6',
  muted: '#F3F4F6',
  mutedForeground: '#6B7280',
  accent: '#E5E7EB',
  border: '#E5E7EB',
  destructive: '#DC2626',
  sidebar: '#FFFFFF',
  sidebarForeground: '#1A1C1F',
  sidebarBorder: '#E5E7EB',
  sidebarAccent: '#F3F4F6',
}

export const statusColors: Record<string, string> = {
  NotStarted: '#71717a',
  Triaging: '#71717a',
  AgentWorking: '#fbbf24',
  ReadyForReview: '#c084fc',
  AgentLearning: '#60a5fa',
  Completed: '#34d399',
}

export const fontFamily =
  '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
