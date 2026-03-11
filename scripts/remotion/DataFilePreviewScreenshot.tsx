import React from 'react'
import { AbsoluteFill } from 'remotion'

// Sample data to showcase the DataFilePreview component
const sampleColumns = ['name', 'email', 'department', 'salary', 'start_date', 'status']
const sampleRows = [
  { name: 'Alice Chen', email: 'alice@acme.co', department: 'Engineering', salary: 145000, start_date: '2023-01-15', status: 'Active' },
  { name: 'Bob Martinez', email: 'bob@acme.co', department: 'Marketing', salary: 98000, start_date: '2022-06-20', status: 'Active' },
  { name: 'Carol Patel', email: 'carol@acme.co', department: 'Engineering', salary: 152000, start_date: '2021-11-03', status: 'Active' },
  { name: 'David Kim', email: 'david@acme.co', department: 'Sales', salary: 115000, start_date: '2023-03-08', status: 'On Leave' },
  { name: 'Eva Johnson', email: 'eva@acme.co', department: 'Engineering', salary: 138000, start_date: '2022-09-14', status: 'Active' },
  { name: 'Frank Liu', email: 'frank@acme.co', department: 'Design', salary: 105000, start_date: '2024-01-22', status: 'Active' },
  { name: 'Grace Wilson', email: 'grace@acme.co', department: 'Engineering', salary: 160000, start_date: '2020-04-10', status: 'Active' },
  { name: 'Henry Brown', email: 'henry@acme.co', department: 'Marketing', salary: 92000, start_date: '2023-07-01', status: 'Active' },
]

// Simulated chat message context
function ToolCallHeader() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
    }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      <span style={{ color: '#e6edf3' }}>Read</span>
      <span style={{ color: '#8b949e' }}>— employees.csv</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3fb950" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto' }}>
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    </div>
  )
}

function DataTable() {
  return (
    <div style={{
      borderRadius: 6,
      background: '#161b22',
      border: '1px solid rgba(255,255,255,0.08)',
      overflow: 'hidden',
    }}>
      {/* Table Header Bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 500, color: '#e6edf3' }}>employees.csv</span>
          <span style={{ fontSize: 10, color: '#8b949e' }}>1,247 rows · 6 cols</span>
        </div>
        <div style={{
          padding: '4px 8px',
          borderRadius: 4,
          background: 'rgba(255,255,255,0.06)',
          cursor: 'pointer',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </div>
      </div>

      {/* Table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: '#0d1117', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 500, color: '#8b949e', width: 36 }}>#</th>
            {sampleColumns.map((col) => (
              <th key={col} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 500, color: '#8b949e', whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {col}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity={0.3}>
                    <path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" />
                  </svg>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sampleRows.map((row, i) => (
            <tr
              key={i}
              style={{
                borderBottom: '1px solid rgba(255,255,255,0.03)',
                background: i % 2 === 1 ? 'rgba(255,255,255,0.01)' : 'transparent',
              }}
            >
              <td style={{ padding: '6px 10px', color: '#8b949e', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</td>
              <td style={{ padding: '6px 10px', color: '#d2d8e0' }}>{row.name}</td>
              <td style={{ padding: '6px 10px', color: '#d2d8e0' }}>{row.email}</td>
              <td style={{ padding: '6px 10px', color: '#d2d8e0' }}>{row.department}</td>
              <td style={{ padding: '6px 10px', color: '#d2d8e0' }}>{row.salary.toLocaleString()}</td>
              <td style={{ padding: '6px 10px', color: '#d2d8e0' }}>{row.start_date}</td>
              <td style={{ padding: '6px 10px', color: row.status === 'Active' ? '#3fb950' : '#d29922' }}>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Footer */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 12px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: '#0d1117',
      }}>
        <span style={{ fontSize: 10, color: '#8b949e' }}>Showing 8 of 1,247 rows (truncated)</span>
        <span style={{ fontSize: 10, color: '#58a6ff', cursor: 'pointer' }}>View full table →</span>
      </div>
    </div>
  )
}

export const DataFilePreviewScreenshot: React.FC = () => {
  return (
    <AbsoluteFill style={{
      background: '#0d1117',
      padding: 40,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      {/* Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="3" y1="15" x2="21" y2="15" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
        <span style={{ fontSize: 18, fontWeight: 600, color: '#e6edf3' }}>Data File Viewer</span>
        <span style={{ fontSize: 12, color: '#8b949e', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: 12 }}>
          inline preview
        </span>
      </div>

      {/* Chat context - tool call message */}
      <div style={{
        borderRadius: 6,
        background: '#161b22',
        border: '1px solid rgba(255,255,255,0.08)',
        overflow: 'hidden',
      }}>
        <ToolCallHeader />

        {/* Embedded Data Preview */}
        <div style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <DataTable />
        </div>

        {/* Timestamp */}
        <div style={{ padding: '4px 12px 8px', display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 10, color: '#8b949e' }}>2:34:12 PM</span>
          <span style={{ fontSize: 10, color: '#8b949e' }}>1.2s · in:450 out:120</span>
        </div>
      </div>

      {/* Feature callouts */}
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        {[
          { label: 'Sort columns', desc: 'Click headers to sort' },
          { label: 'Fullscreen', desc: 'Expand for deep analysis' },
          { label: 'Auto-detect', desc: 'CSV, JSON, Excel, TSV' },
          { label: 'Filter rows', desc: 'Search across all columns' },
        ].map((feat) => (
          <div key={feat.label} style={{
            flex: 1,
            padding: '12px 16px',
            borderRadius: 8,
            background: '#161b22',
            border: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: '#e6edf3', marginBottom: 4 }}>{feat.label}</div>
            <div style={{ fontSize: 11, color: '#8b949e' }}>{feat.desc}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  )
}
