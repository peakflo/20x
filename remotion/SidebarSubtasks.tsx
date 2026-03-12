import React from 'react'
import { AbsoluteFill } from 'remotion'
import { theme, statusColors, fontFamily } from './theme'

const StatusDot: React.FC<{ color: string; size?: number; pulse?: boolean }> = ({
  color,
  size = 8,
  pulse,
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: color,
      flexShrink: 0,
      opacity: pulse ? 0.85 : 1,
    }}
  />
)

interface TaskItemProps {
  title: string
  status: string
  isSelected?: boolean
  subtaskCount?: number
  isSubtask?: boolean
}

const TaskItem: React.FC<TaskItemProps> = ({
  title,
  status,
  isSelected,
  subtaskCount,
  isSubtask,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 12px',
      borderRadius: 8,
      backgroundColor: isSelected ? theme.accent : 'transparent',
      cursor: 'pointer',
    }}
  >
    <StatusDot color={statusColors[status]} size={isSubtask ? 6 : 8} />
    <span
      style={{
        flex: 1,
        fontSize: isSubtask ? 12 : 13,
        color: isSubtask ? theme.sidebarForeground : theme.foreground,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {title}
    </span>
    {subtaskCount !== undefined && subtaskCount > 0 && (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          color: theme.mutedForeground,
          fontSize: 11,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12h-8" /><path d="M21 6H8" /><path d="M21 18h-8" />
          <path d="M3 6v4c0 1.1.9 2 2 2h3" /><path d="M3 10v6c0 1.1.9 2 2 2h3" />
        </svg>
        {subtaskCount}
      </div>
    )}
  </div>
)

const Chevron: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke={theme.mutedForeground}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
      flexShrink: 0,
    }}
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
)

const SectionHeader: React.FC<{ label: string; count: number; open: boolean }> = ({
  label,
  count,
  open,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 12px',
      marginTop: 4,
      fontSize: 11,
      color: theme.mutedForeground,
      cursor: 'pointer',
    }}
  >
    <Chevron expanded={open} />
    {label}
    <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
  </div>
)

export const SidebarSubtasks: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        fontFamily,
        backgroundColor: theme.background,
        display: 'grid',
        gridTemplateColumns: '260px 1fr',
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          backgroundColor: theme.sidebar,
          borderRight: `1px solid ${theme.sidebarBorder}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Drag region / header */}
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

        {/* Task list */}
        <div style={{ flex: 1, padding: '8px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Regular task */}
          <TaskItem title="Set up CI/CD pipeline" status="AgentWorking" />

          {/* Parent task with expanded subtasks */}
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
                  cursor: 'pointer',
                }}
              >
                <Chevron expanded={true} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TaskItem
                  title="Implement user authentication"
                  status="AgentWorking"
                  isSelected={true}
                  subtaskCount={3}
                />
              </div>
            </div>
            {/* Subtasks - expanded */}
            <div
              style={{
                marginLeft: 20,
                paddingLeft: 8,
                borderLeft: `1px solid ${theme.border}40`,
              }}
            >
              <TaskItem title="Design login page UI" status="Completed" isSubtask />
              <TaskItem title="Set up OAuth provider" status="AgentWorking" isSubtask />
              <TaskItem title="Write auth middleware" status="NotStarted" isSubtask />
            </div>
          </div>

          {/* Another parent - collapsed */}
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
                cursor: 'pointer',
              }}
            >
              <Chevron expanded={false} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TaskItem title="Database migration system" status="ReadyForReview" subtaskCount={2} />
            </div>
          </div>

          {/* Regular task */}
          <TaskItem title="Fix timezone handling" status="NotStarted" />

          {/* Completed section */}
          <SectionHeader label="Completed" count={5} open={false} />
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 16px',
            borderTop: `1px solid ${theme.border}`,
            fontSize: 11,
            color: theme.mutedForeground,
            display: 'flex',
            gap: 12,
          }}
        >
          <span>4 active</span>
          <span>5 completed</span>
        </div>
      </div>

      {/* Main content area placeholder */}
      <div
        style={{
          backgroundColor: theme.background,
          display: 'flex',
          flexDirection: 'column',
          padding: 32,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.foreground, margin: 0 }}>
            Implement user authentication
          </h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 6,
                backgroundColor: '#fbbf2418',
                color: '#fbbf24',
                border: '1px solid #fbbf2430',
              }}
            >
              Agent Working
            </span>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 6,
                backgroundColor: '#3b82f618',
                color: '#60a5fa',
                border: '1px solid #3b82f630',
              }}
            >
              Coding
            </span>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 6,
                backgroundColor: '#f9731618',
                color: '#fb923c',
                border: '1px solid #f9731630',
              }}
            >
              High
            </span>
          </div>
          <p
            style={{
              fontSize: 13,
              color: theme.mutedForeground,
              lineHeight: 1.6,
              margin: 0,
              maxWidth: 600,
            }}
          >
            Implement full authentication flow including login, signup, password reset, and OAuth
            integration. Support Google and GitHub OAuth providers.
          </p>
        </div>
      </div>
    </AbsoluteFill>
  )
}
