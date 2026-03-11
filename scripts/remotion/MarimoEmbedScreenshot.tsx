import React from 'react'
import { AbsoluteFill } from 'remotion'

// Render all states of MarimoEmbed as they appear inline in the chat

function IdleState() {
  return (
    <div style={{
      borderRadius: 6,
      background: '#161b22',
      border: '1px solid rgba(88,166,255,0.3)',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
        {/* Code2 icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 500, color: '#e6edf3' }}>analysis_dashboard.py</span>
        <span style={{
          fontSize: 10, color: 'rgba(88,166,255,0.7)',
          background: 'rgba(88,166,255,0.1)',
          padding: '2px 8px', borderRadius: 12,
        }}>marimo notebook</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#58a6ff', color: '#fff',
            padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="white" stroke="none">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Run
          </div>
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '4px 8px', borderRadius: 6, fontSize: 12,
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  )
}

function LaunchingState() {
  return (
    <div style={{
      borderRadius: 6,
      background: '#161b22',
      border: '1px solid rgba(88,166,255,0.3)',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px' }}>
        {/* Spinner (static representation) */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span style={{ fontSize: 12, color: '#8b949e' }}>Starting marimo run server...</span>
      </div>
    </div>
  )
}

function RunningState() {
  return (
    <div style={{
      borderRadius: 6,
      background: '#161b22',
      border: '1px solid rgba(88,166,255,0.3)',
      overflow: 'hidden',
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px',
        background: '#0d1117',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 500, color: '#e6edf3' }}>analysis_dashboard.py</span>
        <span style={{ fontSize: 10, color: '#3fb950', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fb950', display: 'inline-block' }} />
          running
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          {/* Edit button */}
          <div style={{ padding: '2px 8px', borderRadius: 4, cursor: 'pointer' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
            </svg>
          </div>
          {/* External link */}
          <div style={{ padding: '2px 8px', borderRadius: 4, cursor: 'pointer' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </div>
          {/* Fullscreen */}
          <div style={{ padding: '2px 8px', borderRadius: 4, cursor: 'pointer' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </div>
          {/* Stop */}
          <div style={{ padding: '2px 8px', borderRadius: 4, cursor: 'pointer' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f85149" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            </svg>
          </div>
        </div>
      </div>

      {/* Fake marimo iframe content */}
      <div style={{
        height: 320,
        background: '#1a1a2e',
        padding: 20,
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      }}>
        {/* Marimo app header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 16px',
          background: '#16213e',
          borderRadius: 8,
          marginBottom: 16,
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#e6edf3' }}>Sales Analytics Dashboard</span>
        </div>

        {/* Simulated marimo cells */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          {/* Chart cell */}
          <div style={{
            flex: 2,
            background: '#0f3460',
            borderRadius: 8,
            padding: 16,
            border: '1px solid rgba(88,166,255,0.15)',
          }}>
            <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 8 }}>Revenue by Quarter</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 100 }}>
              {[60, 85, 72, 95, 110, 88, 120, 105].map((h, i) => (
                <div key={i} style={{
                  flex: 1,
                  height: `${h}%`,
                  background: `linear-gradient(180deg, #58a6ff ${100 - h}%, #1f6feb 100%)`,
                  borderRadius: '4px 4px 0 0',
                  opacity: 0.8,
                }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              {['Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'].map((q, i) => (
                <span key={i} style={{ fontSize: 9, color: '#8b949e' }}>{q}</span>
              ))}
            </div>
          </div>

          {/* Stats cell */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Total Revenue', value: '$2.4M', change: '+12%', color: '#3fb950' },
              { label: 'Active Users', value: '14,832', change: '+8%', color: '#3fb950' },
              { label: 'Churn Rate', value: '2.1%', change: '-0.3%', color: '#3fb950' },
            ].map((stat) => (
              <div key={stat.label} style={{
                background: '#0f3460',
                borderRadius: 8,
                padding: '10px 12px',
                border: '1px solid rgba(88,166,255,0.15)',
              }}>
                <div style={{ fontSize: 10, color: '#8b949e' }}>{stat.label}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 18, fontWeight: 600, color: '#e6edf3' }}>{stat.value}</span>
                  <span style={{ fontSize: 10, color: stat.color }}>{stat.change}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Data table cell */}
        <div style={{
          background: '#0f3460',
          borderRadius: 8,
          padding: '8px 12px',
          border: '1px solid rgba(88,166,255,0.15)',
        }}>
          <div style={{ fontSize: 10, color: '#8b949e', marginBottom: 6 }}>mo.ui.dataframe(df)</div>
          <div style={{ display: 'flex', gap: 0 }}>
            {['Product', 'Revenue', 'Growth', 'Region'].map((col) => (
              <span key={col} style={{
                flex: 1, fontSize: 10, fontWeight: 500, color: '#8b949e',
                padding: '4px 8px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>{col}</span>
            ))}
          </div>
          {[
            ['Enterprise SaaS', '$890K', '+18%', 'APAC'],
            ['Developer Tools', '$620K', '+24%', 'NA'],
          ].map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 0 }}>
              {row.map((cell, j) => (
                <span key={j} style={{
                  flex: 1, fontSize: 10, color: '#d2d8e0',
                  padding: '3px 8px',
                }}>{cell}</span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function NotInstalledState() {
  return (
    <div style={{
      borderRadius: 6,
      background: '#161b22',
      border: '1px solid rgba(210,153,34,0.3)',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d29922" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div>
          <span style={{ fontSize: 12, color: '#e6edf3', display: 'block' }}>analysis_dashboard.py</span>
          <span style={{ fontSize: 10, color: '#8b949e' }}>
            marimo is not installed. Run: <code style={{
              color: '#d29922', background: 'rgba(210,153,34,0.1)',
              padding: '1px 4px', borderRadius: 3,
            }}>pip install marimo</code>
          </span>
        </div>
      </div>
    </div>
  )
}

function ToolCallWrapper({ children, toolName }: { children: React.ReactNode; toolName: string }) {
  return (
    <div style={{
      borderRadius: 6,
      background: '#161b22',
      border: '1px solid rgba(255,255,255,0.08)',
      overflow: 'hidden',
    }}>
      {/* Tool call header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px',
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace',
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(90deg)' }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span style={{ color: '#e6edf3' }}>{toolName}</span>
        <span style={{ color: '#8b949e' }}>— analysis_dashboard.py</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3fb950" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto' }}>
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>

      {/* Marimo embed below tool call */}
      <div style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {children}
      </div>

      {/* Timestamp */}
      <div style={{ padding: '4px 12px 8px' }}>
        <span style={{ fontSize: 10, color: '#8b949e' }}>2:41:08 PM · 3.2s</span>
      </div>
    </div>
  )
}

export const MarimoEmbedScreenshot: React.FC = () => {
  return (
    <AbsoluteFill style={{
      background: '#0d1117',
      padding: 32,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      overflow: 'hidden',
    }}>
      {/* Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
        </svg>
        <span style={{ fontSize: 16, fontWeight: 600, color: '#e6edf3' }}>Marimo Embed — Inline in Agent Chat</span>
      </div>

      {/* State 1: Agent writes file → idle state with Run button */}
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: -4 }}>Agent writes a marimo notebook → detected automatically:</div>
      <ToolCallWrapper toolName="Write">
        <IdleState />
      </ToolCallWrapper>

      {/* State 2: Running with live iframe */}
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: -4 }}>User clicks Run → live marimo app embedded inline:</div>
      <RunningState />
    </AbsoluteFill>
  )
}
