import React from 'react'
import { AbsoluteFill } from 'remotion'
import { theme, statusColors, fontFamily } from './theme'

const StatusDot: React.FC<{ color: string; size?: number }> = ({ color, size = 8 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: color,
      flexShrink: 0,
    }}
  />
)

const Badge: React.FC<{
  label: string
  bg: string
  fg: string
  border: string
}> = ({ label, bg, fg, border }) => (
  <span
    style={{
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 6,
      backgroundColor: bg,
      color: fg,
      border: `1px solid ${border}`,
    }}
  >
    {label}
  </span>
)

interface SubtaskRowProps {
  title: string
  status: string
  statusLabel: string
}

const SubtaskRow: React.FC<SubtaskRowProps> = ({ title, status, statusLabel }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 12px',
      borderRadius: 8,
      cursor: 'pointer',
      backgroundColor: 'transparent',
    }}
  >
    <StatusDot color={statusColors[status]} size={7} />
    <span style={{ flex: 1, fontSize: 13, color: theme.foreground }}>{title}</span>
    <span style={{ fontSize: 11, color: theme.mutedForeground }}>{statusLabel}</span>
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={theme.mutedForeground}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  </div>
)

export const DetailViewSubtasks: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        fontFamily,
        backgroundColor: theme.background,
        display: 'grid',
        gridTemplateColumns: '260px 1fr',
      }}
    >
      {/* Sidebar (dimmed) */}
      <div
        style={{
          backgroundColor: theme.sidebar,
          borderRight: `1px solid ${theme.sidebarBorder}`,
          opacity: 0.5,
        }}
      />

      {/* Main content */}
      <div
        style={{
          backgroundColor: theme.background,
          display: 'flex',
          flexDirection: 'column',
          padding: '32px 40px',
          gap: 24,
          overflow: 'hidden',
        }}
      >
        {/* Title + badges */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.foreground, margin: 0 }}>
            Implement user authentication
          </h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <Badge label="Agent Working" bg="#fbbf2418" fg="#fbbf24" border="#fbbf2430" />
            <Badge label="Coding" bg="#3b82f618" fg="#60a5fa" border="#3b82f630" />
            <Badge label="High" bg="#f9731618" fg="#fb923c" border="#f9731630" />
          </div>
        </div>

        {/* Description */}
        <p
          style={{
            fontSize: 13,
            color: theme.mutedForeground,
            lineHeight: 1.6,
            margin: 0,
            maxWidth: 640,
          }}
        >
          Implement full authentication flow including login, signup, password reset, and OAuth
          integration. Support Google and GitHub OAuth providers.
        </p>

        {/* Separator */}
        <div style={{ height: 1, backgroundColor: theme.border }} />

        {/* Subtasks Section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke={theme.mutedForeground}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12h-8" /><path d="M21 6H8" /><path d="M21 18h-8" />
              <path d="M3 6v4c0 1.1.9 2 2 2h3" /><path d="M3 10v6c0 1.1.9 2 2 2h3" />
            </svg>
            <span style={{ fontSize: 14, fontWeight: 500, color: theme.foreground }}>
              Subtasks
            </span>
            <span
              style={{
                fontSize: 11,
                color: theme.mutedForeground,
                backgroundColor: theme.muted,
                padding: '1px 6px',
                borderRadius: 4,
              }}
            >
              3
            </span>
          </div>

          <div
            style={{
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <SubtaskRow title="Design login page UI" status="Completed" statusLabel="Completed" />
            <div style={{ height: 1, backgroundColor: theme.border, margin: '0 12px' }} />
            <SubtaskRow title="Set up OAuth provider" status="AgentWorking" statusLabel="Agent Working" />
            <div style={{ height: 1, backgroundColor: theme.border, margin: '0 12px' }} />
            <SubtaskRow title="Write auth middleware" status="NotStarted" statusLabel="Not Started" />
          </div>
        </div>

        {/* Agent info */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ height: 1, backgroundColor: theme.border }} />
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: theme.mutedForeground }}>Agent</span>
              <span style={{ fontSize: 13, color: theme.foreground }}>Claude Sonnet</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: theme.mutedForeground }}>Repo</span>
              <span style={{ fontSize: 13, color: theme.primary }}>peakflo/20x</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: theme.mutedForeground }}>Created</span>
              <span style={{ fontSize: 13, color: theme.foreground }}>Mar 12, 2026</span>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}
