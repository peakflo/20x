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

const SidebarTaskItem: React.FC<{
  title: string
  status: string
  isSelected?: boolean
  isSubtask?: boolean
}> = ({ title, status, isSelected, isSubtask }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 12px',
      borderRadius: 8,
      backgroundColor: isSelected ? theme.accent : 'transparent',
    }}
  >
    <StatusDot color={statusColors[status]} size={isSubtask ? 6 : 8} />
    <span
      style={{
        flex: 1,
        fontSize: isSubtask ? 12 : 13,
        color: isSelected
          ? theme.foreground
          : isSubtask
            ? theme.sidebarForeground
            : theme.foreground,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {title}
    </span>
  </div>
)

export const SubtaskNavigation: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        fontFamily,
        backgroundColor: theme.background,
        display: 'grid',
        gridTemplateColumns: '260px 1fr',
      }}
    >
      {/* Sidebar with subtask selected */}
      <div
        style={{
          backgroundColor: theme.sidebar,
          borderRight: `1px solid ${theme.sidebarBorder}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 52,
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: theme.foreground }}>Tasks</span>
        </div>

        <div style={{ flex: 1, padding: '8px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SidebarTaskItem title="Set up CI/CD pipeline" status="AgentWorking" />

          {/* Parent with expanded subtasks - subtask selected */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  marginLeft: 4,
                  color: theme.mutedForeground,
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transform: 'rotate(90deg)' }}
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <SidebarTaskItem title="Implement user authentication" status="AgentWorking" />
              </div>
            </div>
            <div
              style={{
                marginLeft: 20,
                paddingLeft: 8,
                borderLeft: `1px solid ${theme.border}40`,
              }}
            >
              <SidebarTaskItem title="Design login page UI" status="Completed" isSubtask />
              <SidebarTaskItem
                title="Set up OAuth provider"
                status="AgentWorking"
                isSubtask
                isSelected={true}
              />
              <SidebarTaskItem title="Write auth middleware" status="NotStarted" isSubtask />
            </div>
          </div>

          <SidebarTaskItem title="Database migration system" status="ReadyForReview" />
          <SidebarTaskItem title="Fix timezone handling" status="NotStarted" />
        </div>
      </div>

      {/* Main content - subtask detail view */}
      <div
        style={{
          backgroundColor: theme.background,
          display: 'flex',
          flexDirection: 'column',
          padding: '32px 40px',
          gap: 20,
        }}
      >
        {/* Breadcrumb - back to parent */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
          }}
        >
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
            <path d="m12 19-7-7 7-7" />
            <path d="M19 12H5" />
          </svg>
          <span style={{ fontSize: 12, color: theme.mutedForeground }}>
            Implement user authentication
          </span>
        </div>

        {/* Subtask title + badges */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.foreground, margin: 0 }}>
            Set up OAuth provider
          </h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <Badge label="Agent Working" bg="#fbbf2418" fg="#fbbf24" border="#fbbf2430" />
            <Badge label="Coding" bg="#3b82f618" fg="#60a5fa" border="#3b82f630" />
            <Badge label="High" bg="#f9731618" fg="#fb923c" border="#f9731630" />
            <Badge label="Subtask" bg="#8b5cf618" fg="#a78bfa" border="#8b5cf630" />
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
          Configure Google and GitHub OAuth providers. Set up callback routes, token exchange, and
          profile mapping to the user model.
        </p>

        <div style={{ height: 1, backgroundColor: theme.border }} />

        {/* Sibling subtasks context */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 12, color: theme.mutedForeground, fontWeight: 500 }}>
            Other subtasks in this group
          </span>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '8px 12px',
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusDot color={statusColors.Completed} size={6} />
              <span style={{ fontSize: 12, color: theme.sidebarForeground }}>
                Design login page UI
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: statusColors.Completed,
                  marginLeft: 'auto',
                }}
              >
                Completed
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusDot color={statusColors.NotStarted} size={6} />
              <span style={{ fontSize: 12, color: theme.sidebarForeground }}>
                Write auth middleware
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: statusColors.NotStarted,
                  marginLeft: 'auto',
                }}
              >
                Not Started
              </span>
            </div>
          </div>
        </div>

        {/* Agent section */}
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
              <span style={{ fontSize: 11, color: theme.mutedForeground }}>Parent</span>
              <span style={{ fontSize: 13, color: theme.primary }}>Implement user authentication</span>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}
